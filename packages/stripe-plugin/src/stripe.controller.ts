import { Controller, Headers, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { PaymentMethod, RequestContext } from '@vendure/core';
import {
    ChannelService,
    InternalServerError,
    LanguageCode,
    Logger,
    Order,
    OrderService,
    Payment,
    PaymentMethodService,
    RequestContextService,
    TransactionalConnection,
} from '@vendure/core';
import { OrderStateTransitionError } from '@vendure/core/dist/common/error/generated-graphql-shop-errors';
import type { Response } from 'express';
import type Stripe from 'stripe';

import { loggerCtx, STRIPE_PLUGIN_OPTIONS } from './constants';
import { isExpectedVendureStripeEventMetadata } from './stripe-utils';
import { stripePaymentMethodHandler } from './stripe.handler';
import { StripeService } from './stripe.service';
import { RequestWithRawBody, StripePluginOptions } from './types';

const missingHeaderErrorMessage = 'Missing stripe-signature header';
const signatureErrorMessage = 'Error verifying Stripe webhook signature';
const noPaymentIntentErrorMessage = 'No payment intent in the event payload';
const ignorePaymentIntentEvent = 'Event has no Vendure metadata, skipped.';

@Controller('payments')
export class StripeController {
    /**
     * Per-order mutex chains serializing webhook settlement within this
     * process. The pessimistic row lock inside the transaction covers
     * overlap across processes, but SQLite-family drivers cannot take it —
     * and the e2e suite runs on sqljs — so same-process overlap is
     * serialized here on every driver instead.
     */
    private readonly settlementLocks = new Map<string, Promise<void>>();

    constructor(
        @Inject(STRIPE_PLUGIN_OPTIONS) private options: StripePluginOptions,
        private paymentMethodService: PaymentMethodService,
        private orderService: OrderService,
        private stripeService: StripeService,
        private requestContextService: RequestContextService,
        private connection: TransactionalConnection,
        private channelService: ChannelService,
    ) {}

    @Post('stripe')
    async webhook(
        @Headers('stripe-signature') signature: string | undefined,
        @Req() request: RequestWithRawBody,
        @Res() response: Response,
    ): Promise<void> {
        if (!signature) {
            Logger.error(missingHeaderErrorMessage, loggerCtx);
            response.status(HttpStatus.BAD_REQUEST).send(missingHeaderErrorMessage);
            return;
        }

        // Everything parsed here is untrusted until the signature is verified
        // below. Only the event shape is inspected pre-verification, so that
        // foreign payment intents can still be skipped with a 200.
        const unverifiedEvent = JSON.parse(request.body.toString()) as Stripe.Event;
        const unverifiedPaymentIntent = unverifiedEvent.data.object as Stripe.PaymentIntent;

        if (!unverifiedPaymentIntent) {
            Logger.error(noPaymentIntentErrorMessage, loggerCtx);
            response.status(HttpStatus.BAD_REQUEST).send(noPaymentIntentErrorMessage);
            return;
        }

        const { metadata: unverifiedMetadata } = unverifiedPaymentIntent;

        if (!isExpectedVendureStripeEventMetadata(unverifiedMetadata)) {
            if (this.options.skipPaymentIntentsWithoutExpectedMetadata) {
                response.status(HttpStatus.OK).send(ignorePaymentIntentEvent);
                return;
            }
            throw new Error(
                `Missing expected payment intent metadata, unable to settle payment ${unverifiedPaymentIntent.id}!`,
            );
        }

        const { channelToken, languageCode } = unverifiedMetadata;

        const outerCtx = await this.createContext(channelToken, languageCode, request);

        // Verify the signature before looking up the order: the secret is
        // resolved from the channel, so no order is needed yet. From here on,
        // `event` is the trusted payload returned by Stripe's SDK.
        let event: Stripe.Event;
        try {
            // Throws an error if the signature is invalid
            event = await this.stripeService.constructEventForChannel(
                outerCtx,
                request.rawBody,
                signature,
            );
        } catch (e: any) {
            Logger.error(`${signatureErrorMessage} ${signature}: ${(e as Error)?.message}`, loggerCtx);
            response.status(HttpStatus.BAD_REQUEST).send(signatureErrorMessage);
            return;
        }

        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const { orderCode, orderId } = paymentIntent.metadata as {
            orderCode: string;
            orderId: string;
        };

        const releaseSettlementLock = await this.acquireOrderSettlementLock(orderCode);
        await this.connection
            .withTransaction(outerCtx, async (ctx: RequestContext) => {
            const order = await this.orderService.findOneByCode(ctx, orderCode);

            if (!order) {
                throw new Error(
                    `Unable to find order ${orderCode}, unable to settle payment ${paymentIntent.id}!`,
                );
            }

            // Serialize settlement for this order across processes: without a
            // lock, two overlapping deliveries can both pass the idempotency
            // check below and settle twice. SQLite-family drivers do not
            // support pessimistic locks, so this degrades gracefully there —
            // same-process overlap on those drivers is serialized by the
            // in-process mutex instead (see acquireOrderSettlementLock).
            try {
                await this.connection
                    .getRepository(ctx, Order)
                    .createQueryBuilder('order')
                    .setLock('pessimistic_write')
                    .where('order.id = :orderId', { orderId })
                    .getOne();
            } catch {
                // Lock not supported (e.g. SQLite) — continue without it
            }

            // The secret was resolved without the order; run the unchanged
            // eligibility gate now that the order is known.
            await this.stripeService.getStripeClient(ctx, order);

            if (event.type === 'payment_intent.payment_failed') {
                const message = paymentIntent.last_payment_error?.message ?? 'unknown error';
                Logger.warn(`Payment for order ${orderCode} failed: ${message}`, loggerCtx);
                response.status(HttpStatus.OK).send('Ok');
                return;
            }

            if (event.type !== 'payment_intent.succeeded') {
                // This should never happen as the webhook is configured to receive
                // payment_intent.succeeded and payment_intent.payment_failed events only
                Logger.info(`Received ${event.type} status update for order ${orderCode}`, loggerCtx);
                return;
            }

            // Stripe guarantees at-least-once delivery, so this event can arrive again:
            // on its retry schedule after a slow or failed response, or when an endpoint
            // is replayed. Recognising that as "already done" is what lets the failure
            // paths below throw. Without it, a redelivery falls through to a state
            // transition that cannot succeed from PaymentSettled, and would be reported
            // as a settlement failure — leaving Stripe retrying a settled order forever.
            const existingPayment = await this.connection
                .getRepository(ctx, Payment)
                .createQueryBuilder('payment')
                .innerJoin('payment.order', 'order')
                .where('payment.transactionId = :transactionId', { transactionId: paymentIntent.id })
                .andWhere('order.id = :orderId', { orderId })
                .getOne();

            if (existingPayment) {
                Logger.info(
                    `Stripe payment intent id ${paymentIntent.id} already added to order ${orderCode}`,
                    loggerCtx,
                );
                return;
            }

            if (order.state !== 'ArrangingPayment' && order.state !== 'ArrangingAdditionalPayment') {
                // The stripe plugin based on https://github.com/vendurehq/vendure/pull/3624 can export the
                // StripeService to support additional payment flows where state can be ArrangingAdditionalPayment.

                // Orders can switch channels (e.g., global to UK store), causing lookups by the original
                // channel to fail. Using a default channel avoids "entity-with-id-not-found" errors.
                // See https://github.com/vendurehq/vendure/issues/3072

                // First use the channel specific context to transition the order state, which is the default behavior
                // prior to issue: https://github.com/vendurehq/vendure/issues/3072
                let transitionToStateResult = await this.orderService.transitionToState(
                    ctx,
                    orderId,
                    'ArrangingPayment',
                );

                // If the channel specific context fails, try to use the default channel context
                // to transition the order state. Issue: https://github.com/vendurehq/vendure/issues/3072
                if (transitionToStateResult instanceof OrderStateTransitionError) {
                    const defaultChannel = await this.channelService.getDefaultChannel(ctx);
                    const ctxWithDefaultChannel = await this.createContext(
                        defaultChannel.token,
                        languageCode,
                        request,
                    );

                    transitionToStateResult = await this.orderService.transitionToState(
                        ctxWithDefaultChannel,
                        orderId,
                        'ArrangingPayment',
                    );
                }

                // If the order is still not in the ArrangingPayment state, fail the
                // request. Returning here logged the error but still answered 2xx, so
                // Stripe recorded the event as delivered and never retried: the money
                // was captured and the order left unsettled, with nothing but a log
                // line to notice it by.
                if (transitionToStateResult instanceof OrderStateTransitionError) {
                    Logger.error(
                        `Error transitioning order ${orderCode} to ArrangingPayment state: ${transitionToStateResult.message}`,
                        loggerCtx,
                    );
                    throw new InternalServerError(
                        `Stripe settlement failed for order ${orderCode}: could not transition to ArrangingPayment`,
                    );
                }
            }

            const paymentMethod = await this.getPaymentMethod(ctx);

            const addPaymentToOrderResult = await this.orderService.addPaymentToOrder(ctx, orderId, {
                method: paymentMethod.code,
                metadata: {
                    paymentIntentAmountReceived: paymentIntent.amount_received,
                    paymentIntentId: paymentIntent.id,
                },
            });

            if (!(addPaymentToOrderResult instanceof Order)) {
                Logger.error(
                    `Error adding payment to order ${orderCode}: ${addPaymentToOrderResult.message}`,
                    loggerCtx,
                );
                throw new InternalServerError(
                    `Stripe settlement failed for order ${orderCode}: ${addPaymentToOrderResult.message}`,
                );
            }

            // The payment intent ID is added to the order only if we can reach this point.
            Logger.info(
                `Stripe payment intent id ${paymentIntent.id} added to order ${orderCode}`,
                loggerCtx,
            );
            })
            .finally(releaseSettlementLock);

        // Send the response status only if we didn't sent anything yet.
        if (!response.headersSent) {
            response.status(HttpStatus.OK).send('Ok');
        }
    }

    private async createContext(
        channelToken: string,
        languageCode: LanguageCode,
        req: RequestWithRawBody,
    ): Promise<RequestContext> {
        return this.requestContextService.create({
            apiType: 'admin',
            channelOrToken: channelToken,
            // This is a workaround for a type mismatch between express v5 (Vendure core)
            // and express v4 (several transitive dependencies). Can be removed once the
            // ecosystem has more significantly shifted to v5.
            req: req as any,
            languageCode,
        });
    }

    private async getPaymentMethod(ctx: RequestContext): Promise<PaymentMethod> {
        const method = (await this.paymentMethodService.findAll(ctx)).items.find(
            m => m.handler.code === stripePaymentMethodHandler.code,
        );

        if (!method) {
            throw new InternalServerError(`[${loggerCtx}] Could not find Stripe PaymentMethod`);
        }

        return method;
    }

    /**
     * Acquires the per-order settlement mutex, serializing overlapping
     * webhook deliveries within this process. The returned function releases
     * the mutex and must run once the settlement transaction settles (see
     * the `.finally()` at the call site) so a failed delivery cannot wedge
     * later ones. The chain entry is removed once it drains, so the map does
     * not grow over time.
     */
    private async acquireOrderSettlementLock(orderCode: string): Promise<() => void> {
        const previous = this.settlementLocks.get(orderCode) ?? Promise.resolve();
        let release: () => void = () => undefined;
        const current = new Promise<void>(resolve => {
            release = resolve;
        });
        const mine = previous.then(() => current);
        this.settlementLocks.set(orderCode, mine);
        await previous;
        return () => {
            release();
            if (this.settlementLocks.get(orderCode) === mine) {
                this.settlementLocks.delete(orderCode);
            }
        };
    }
}
