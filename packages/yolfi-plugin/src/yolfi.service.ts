import { Inject, Injectable } from '@nestjs/common';
import {
    ConfigService, CreatePaymentResult, Order, OrderService, PaymentMethod, PaymentMethodService,
    RequestContext, RequestContextService, TransactionalConnection,
} from '@vendure/core';
import {
    assertConfirmation, assertCurrency, hostedUrl, merchantReference, parseWebhook, price,
    requestSession, samePrice, YolfiOptions,
} from './yolfi-client';

export const YOLFI_OPTIONS = Symbol('YOLFI_OPTIONS');

@Injectable()
export class YolfiService {
    constructor(
        @Inject(YOLFI_OPTIONS) private options: YolfiOptions,
        private config: ConfigService,
        private methods: PaymentMethodService,
        private orders: OrderService,
        private connection: TransactionalConnection,
        private contexts: RequestContextService,
    ) {}

    private total(order: Order): string {
        assertCurrency(order.currencyCode);
        return price(order.totalWithTax, this.config.entityOptions.moneyStrategy.precision ?? 2);
    }

    private assertUnpaid(order: Order): void {
        if (order.state !== 'ArrangingPayment' || order.payments?.some(p => p.state === 'Authorized' || p.state === 'Settled')) {
            throw new Error('Yolfi requires an unpaid order in ArrangingPayment; partial payments are unsupported');
        }
    }

    async createCheckout(
        ctx: RequestContext, order: Order, paymentMethodCode: string, attemptId = 'initial-checkout-attempt',
    ): Promise<string> {
        if (!/^[a-zA-Z0-9_-]{16,100}$/.test(attemptId)) throw new Error('Invalid Yolfi checkout attempt identifier');
        this.assertUnpaid(order);
        order.payments = await this.orders.getOrderPayments(ctx, order.id);
        this.assertUnpaid(order);
        const amount = this.total(order);
        const { paymentMethod, handler } = await this.methods.getMethodAndOperations(ctx, paymentMethodCode);
        const eligible = await this.orders.getEligiblePaymentMethods(ctx, order.id);
        if (handler.code !== 'yolfi' || !eligible.some(p => String(p.id) === String(paymentMethod.id) && p.isEligible)) {
            throw new Error('Yolfi payment method is not eligible');
        }
        const payload = {
            amount, currency: order.currencyCode, merchantOrderId: merchantReference(ctx, order, paymentMethod),
            successUrl: this.options.successUrl, cancelUrl: this.options.cancelUrl,
            metadata: { orderId: String(order.id), channelToken: ctx.channel.token, paymentMethodCode, attemptId },
        };
        const session = await requestSession(this.options, '', payload);
        if (!samePrice(session.amount, amount) || session.currency !== order.currencyCode ||
            session.merchantOrderId !== payload.merchantOrderId || session.status === 'EXPIRED') {
            throw new Error('Yolfi checkout snapshot does not match the order');
        }
        return hostedUrl(session);
    }

    /** Called by the registered handler; metadata alone can never claim payment. */
    async createPayment(
        ctx: RequestContext, order: Order, amount: number,
        metadata: { body?: string; signature?: string }, method: PaymentMethod,
    ): Promise<CreatePaymentResult> {
        if (ctx.apiType !== 'admin' || typeof metadata?.body !== 'string') {
            throw new Error('Yolfi payments can only be added by a verified webhook');
        }
        this.assertUnpaid(order);
        if (amount !== order.totalWithTax || method.handler.code !== 'yolfi') throw new Error('Yolfi partial payments are unsupported');
        const event = parseWebhook(Buffer.from(metadata.body, 'utf8'), metadata.signature, this.options);
        assertConfirmation(event);
        const data = event.data;
        const reference = merchantReference(ctx, order, method);
        if (data.merchantOrderId !== reference || data.currency !== order.currencyCode ||
            data.metadata.orderId !== String(order.id) || data.metadata.channelToken !== ctx.channel.token ||
            data.metadata.paymentMethodCode !== method.code) throw new Error('Yolfi payment reference mismatch');
        const expected = this.total(order);
        const session = await requestSession(this.options, '/' + encodeURIComponent(data.checkoutSessionId));
        // Webhook amount is a TOKEN receivable. Only the authenticated pricing snapshot is fiat.
        if (session.id !== data.checkoutSessionId || session.status !== 'COMPLETED' ||
            session.merchantOrderId !== reference || session.currency !== order.currencyCode ||
            !samePrice(session.amount, expected)) throw new Error('Yolfi confirmed session does not match the order');
        return { amount, state: 'Settled', transactionId: data.invoiceId,
            metadata: { checkoutSessionId: data.checkoutSessionId, eventId: event.id } };
    }

    async handleWebhook(raw: Buffer, signature: string | undefined): Promise<void> {
        const event = parseWebhook(raw, signature, this.options);
        // No pending payment/authorization is created. Failure, cancel and overdue leave it unpaid.
        if (event.type !== 'payment.confirmed') return;
        assertConfirmation(event);
        const { metadata, invoiceId, checkoutSessionId } = event.data;
        const outer = await this.contexts.create({ apiType: 'admin', channelOrToken: metadata.channelToken });
        await this.connection.withTransaction(outer, async ctx => {
            // First transactional read must lock: concurrent retries see the preceding commit,
            // including on REPEATABLE READ. Never acknowledge a DB/application failure.
            const locked = await this.connection.getRepository(ctx, Order).findOne({
                where: { id: metadata.orderId }, lock: { mode: 'pessimistic_write' },
            });
            if (!locked) throw new Error('Yolfi order is unavailable');
            const order = await this.orders.findOne(ctx, metadata.orderId);
            if (!order) throw new Error('Yolfi order is unavailable in this channel');
            order.payments = await this.orders.getOrderPayments(ctx, order.id);
            const existing = order.payments.find(p => p.transactionId === invoiceId ||
                p.metadata?.eventId === event.id || p.metadata?.checkoutSessionId === checkoutSessionId);
            if (existing) {
                if (existing.state !== 'Settled' || existing.method !== metadata.paymentMethodCode ||
                    existing.transactionId !== invoiceId || existing.metadata?.checkoutSessionId !== checkoutSessionId) {
                    throw new Error('Yolfi duplicate confirmation conflicts with a recorded payment');
                }
                return;
            }
            this.assertUnpaid(order);
            const result = await this.orders.addPaymentToOrder(ctx, order.id, {
                method: metadata.paymentMethodCode, metadata: { body: raw.toString('utf8'), signature },
            });
            if ('errorCode' in result) throw new Error('Vendure rejected the Yolfi payment; reconciliation required');
        });
    }
}
