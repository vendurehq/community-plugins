import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
    ConfigService,
    Customer,
    IllegalOperationError,
    Injector,
    Logger,
    Order,
    Payment,
    PaymentMethod,
    PaymentMethodService,
    RequestContext,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';

import { loggerCtx, STRIPE_PLUGIN_OPTIONS } from './constants';
import { sanitizeMetadata } from './metadata-sanitize';
import { VendureStripeClient } from './stripe-client';
import {
    StripeEvent,
    StripePaymentIntent,
    StripePaymentIntentCreateParams,
    StripeRefund,
    StripeRequestOptions,
} from './stripe-types';
import { getAmountInStripeMinorUnits, isUnexpectedIntentStateError } from './stripe-utils';
import { stripePaymentMethodHandler } from './stripe.handler';
import { StripePluginOptions } from './types';

/**
 * How many PaymentIntents a single order and amount may go through in manual-capture mode (the
 * first one plus replacements for cancelled ones) before intent creation is refused.
 */
const MAX_PAYMENT_INTENT_ATTEMPTS = 10;

const STRIPE_REFUND_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer'] as const;
type StripeRefundReason = (typeof STRIPE_REFUND_REASONS)[number];

function isStripeRefundReason(reason: string | undefined): reason is StripeRefundReason {
    return !!reason && (STRIPE_REFUND_REASONS as readonly string[]).includes(reason);
}

@Injectable()
export class StripeService {
    constructor(
        @Inject(STRIPE_PLUGIN_OPTIONS) private options: StripePluginOptions,
        private connection: TransactionalConnection,
        private paymentMethodService: PaymentMethodService,
        private moduleRef: ModuleRef,
        private configService: ConfigService,
    ) {}

    async createPaymentIntent(ctx: RequestContext, order: Order): Promise<string> {
        let customerId: string | undefined;
        const stripe = await this.getStripeClient(ctx, order);
        const requestOptions = await this.resolveRequestOptions(ctx, order);

        if (this.options.storeCustomersInStripe && ctx.activeUserId) {
            customerId = await this.getStripeCustomerId(ctx, order, requestOptions);
        }
        const amountInMinorUnits = getAmountInStripeMinorUnits(order);

        const additionalParams = await this.options.paymentIntentCreateParams?.(
            new Injector(this.moduleRef),
            ctx,
            order,
        );
        const metadata = sanitizeMetadata({
            ...(typeof this.options.metadata === 'function'
                ? await this.options.metadata(new Injector(this.moduleRef), ctx, order)
                : {}),
            channelToken: ctx.channel.token,
            orderId: order.id,
            orderCode: order.code,
            languageCode: ctx.languageCode,
        });

        const allMetadata = {
            ...metadata,
            ...sanitizeMetadata(additionalParams?.metadata ?? {}),
        };

        // The plugin's `captureMethod` option is authoritative: the payment handler and the
        // webhook flow both branch on `isManualCapture()`, so the created intent must match the
        // configured mode. A `capture_method` returned from `paymentIntentCreateParams` would
        // otherwise override it here and desync the intent from that behaviour, so we enforce the
        // configured value and warn if the callback tried to set a conflicting one.
        const additional = { ...(additionalParams ?? {}) };
        if (this.isManualCapture()) {
            if (additional.capture_method && additional.capture_method !== 'manual') {
                Logger.warn(
                    `Ignoring capture_method '${additional.capture_method}' from paymentIntentCreateParams: ` +
                        `the plugin is configured with captureMethod 'manual', which is authoritative.`,
                    loggerCtx,
                );
            }
            // Manual capture places a hold on the funds (status `requires_capture`) rather than
            // charging immediately, so Vendure can secure stock before the money is captured.
            additional.capture_method = 'manual';
        } else if (additional.capture_method === 'manual') {
            Logger.warn(
                `Ignoring capture_method 'manual' from paymentIntentCreateParams: the plugin is ` +
                    `configured with captureMethod 'automatic', which is authoritative.`,
                loggerCtx,
            );
            delete additional.capture_method;
        }

        const createParams: StripePaymentIntentCreateParams = {
            amount: amountInMinorUnits,
            currency: order.currencyCode.toLowerCase(),
            customer: customerId,
            automatic_payment_methods: {
                enabled: true,
            },
            ...additional,
            metadata: allMetadata,
        };
        const idempotencyKey = `${order.code}_${amountInMinorUnits}`;

        const paymentIntent = await stripe.paymentIntents.create(createParams, {
            idempotencyKey,
            ...(requestOptions ?? {}),
        });

        // In manual-capture mode an intent can be cancelled server-side (for example when a stock
        // check fails after authorization). Because the idempotency key above replays the original
        // response, a same-amount retry would hand back the cancelled intent's client secret, which
        // can no longer be confirmed. Follow the chain of replacements to the current intent.
        const usableIntent = this.isManualCapture()
            ? await this.resolveConfirmableIntent(
                  stripe,
                  paymentIntent,
                  createParams,
                  idempotencyKey,
                  requestOptions,
                  order.code,
              )
            : paymentIntent;

        if (!usableIntent.client_secret) {
            // This should never happen
            Logger.warn(
                `Payment intent creation for order ${order.code} did not return client secret`,
                loggerCtx,
            );
            throw Error('Failed to create payment intent');
        }

        return usableIntent.client_secret;
    }

    /**
     * Whether the plugin is configured to authorize first and capture separately
     * (`captureMethod: 'manual'`).
     */
    isManualCapture(): boolean {
        return this.options.captureMethod === 'manual';
    }

    /**
     * Retrieves the live state of a PaymentIntent. Webhook payloads are a snapshot taken when the
     * event was created, so a redelivered event can describe an intent that has since been captured
     * or cancelled.
     */
    async retrievePaymentIntent(
        ctx: RequestContext,
        order: Order,
        paymentIntentId: string,
    ): Promise<StripePaymentIntent> {
        const stripe = await this.getStripeClient(ctx, order);
        const requestOptions = await this.resolveRequestOptions(ctx, order);
        return stripe.paymentIntents.retrieve(paymentIntentId, undefined, requestOptions);
    }

    /**
     * Captures a previously authorized PaymentIntent, charging the held funds. Called by the
     * webhook controller once the authorized payment has been committed, and by the payment
     * handler's `settlePayment` for captures started from the Admin UI.
     *
     * No idempotency key of our own is sent. Stripe returns the first response for a key for 24
     * hours, errors included, so a fixed key would hand a failed capture back to every retry. The
     * SDK still adds its own key to its internal network retries.
     *
     * Safe to call again: a repeated capture is refused with `payment_intent_unexpected_state`
     * (typically because an earlier attempt already captured it and only the response was lost), and
     * the intent's live state is then returned so the caller can decide from the status.
     */
    async capturePaymentIntent(
        ctx: RequestContext,
        order: Order,
        paymentIntentId: string,
    ): Promise<StripePaymentIntent> {
        const stripe = await this.getStripeClient(ctx, order);
        const requestOptions = await this.resolveRequestOptions(ctx, order);
        try {
            return await stripe.paymentIntents.capture(paymentIntentId, undefined, requestOptions);
        } catch (e) {
            if (isUnexpectedIntentStateError(e)) {
                return stripe.paymentIntents.retrieve(paymentIntentId, undefined, requestOptions);
            }
            throw e;
        }
    }

    /**
     * Voids (cancels) a PaymentIntent, releasing any authorized hold without charging the customer.
     * Used to release the hold when an order cannot be arranged after authorization, and by the
     * handler's `cancelPayment`.
     *
     * Safe to call again: if the intent can no longer be cancelled (typically because an earlier
     * attempt already cancelled it), its live state is returned so the caller can decide from the
     * status.
     */
    async cancelPaymentIntent(
        ctx: RequestContext,
        order: Order,
        paymentIntentId: string,
    ): Promise<StripePaymentIntent> {
        const stripe = await this.getStripeClient(ctx, order);
        const requestOptions = await this.resolveRequestOptions(ctx, order);
        try {
            return await stripe.paymentIntents.cancel(paymentIntentId, undefined, requestOptions);
        } catch (e) {
            if (isUnexpectedIntentStateError(e)) {
                return stripe.paymentIntents.retrieve(paymentIntentId, undefined, requestOptions);
            }
            throw e;
        }
    }

    /**
     * Returns the order's current PaymentIntent if it can still be confirmed. Used only in
     * manual-capture mode, where an intent can be cancelled server-side after authorization.
     *
     * The first intent for an order and amount is created under `${order.code}_${amount}`. When that
     * intent is cancelled, its replacement is created under a key derived from the cancelled intent's
     * ID, so every retry, sequential or concurrent, is handed the same replacement by Stripe instead
     * of creating another one. Stripe's idempotency store is the record of these attempts, so nothing
     * has to be stored on the order.
     *
     * An intent that is already authorized, processing or captured is never replaced, since that
     * would let the customer place a second hold for the same order.
     */
    private async resolveConfirmableIntent(
        stripe: VendureStripeClient,
        createdIntent: StripePaymentIntent,
        createParams: StripePaymentIntentCreateParams,
        idempotencyKey: string,
        requestOptions: StripeRequestOptions | undefined,
        orderCode: string,
    ): Promise<StripePaymentIntent> {
        let intent = createdIntent;
        for (let attempt = 0; attempt < MAX_PAYMENT_INTENT_ATTEMPTS; attempt++) {
            const live = await stripe.paymentIntents.retrieve(intent.id, undefined, requestOptions);
            if (this.isConfirmableStatus(live.status)) {
                return live;
            }
            if (live.status !== 'canceled') {
                throw new IllegalOperationError(
                    `A payment for order ${orderCode} is already authorized or completed (${live.status})`,
                );
            }
            intent = await stripe.paymentIntents.create(createParams, {
                ...(requestOptions ?? {}),
                idempotencyKey: `${idempotencyKey}_after_${live.id}`,
            });
        }
        throw new IllegalOperationError(
            `Too many cancelled payment attempts for order ${orderCode}, please contact support`,
        );
    }

    private isConfirmableStatus(status: StripePaymentIntent['status']): boolean {
        return (
            status === 'requires_payment_method' ||
            status === 'requires_confirmation' ||
            status === 'requires_action'
        );
    }

    async constructEventFromPayload(
        ctx: RequestContext,
        order: Order,
        payload: Buffer,
        signature: string,
    ): Promise<StripeEvent> {
        const stripe = await this.getStripeClient(ctx, order);
        return stripe.webhooks.constructEvent(payload, signature, stripe.webhookSecret);
    }

    async constructEventForChannel(
        ctx: RequestContext,
        payload: Buffer,
        signature: string,
    ): Promise<StripeEvent> {
        const stripe = await this.getStripeClientForChannel(ctx);
        return stripe.webhooks.constructEvent(payload, signature, stripe.webhookSecret);
    }

    async createRefund(
        ctx: RequestContext,
        order: Order,
        payment: Payment,
        amount: number,
        reason?: string,
    ): Promise<StripeRefund> {
        const stripe = await this.getStripeClient(ctx, order);
        const structuredReason = isStripeRefundReason(reason) ? reason : undefined;
        const params: Parameters<typeof stripe.refunds.create>[0] = {
            payment_intent: payment.transactionId,
            amount,
            ...(structuredReason ? { reason: structuredReason } : {}),
            ...(reason && !structuredReason ? { metadata: { vendureRefundReason: reason } } : {}),
        };
        // No idempotency key of our own: refunds are repeatable, so (payment intent, amount) does not
        // identify one refund, and a colliding key makes Stripe replay an earlier refund instead of
        // creating a new one. The SDK attaches a per-call key to its own network retries.
        return stripe.refunds.create(params);
    }

    /**
     * Get Stripe client for a channel, without requiring an order.
     *
     * Used to resolve the webhook secret before the payload is trusted:
     * the credentials come from the channel's enabled Stripe payment
     * method. Order eligibility is checked separately via
     * {@link getStripeClient} once the event is verified.
     */
    async getStripeClientForChannel(ctx: RequestContext): Promise<VendureStripeClient> {
        const stripePaymentMethod = await this.findEnabledStripePaymentMethod(ctx);
        const { apiKey, webhookSecret } = this.getCredentials(stripePaymentMethod);
        return new VendureStripeClient(apiKey, webhookSecret);
    }

    /**
     * Get Stripe client based on eligible payment methods for order
     */
    async getStripeClient(ctx: RequestContext, order: Order): Promise<VendureStripeClient> {
        const [eligiblePaymentMethods, stripePaymentMethod] = await Promise.all([
            this.paymentMethodService.getEligiblePaymentMethods(ctx, order),
            this.findEnabledStripePaymentMethod(ctx),
        ]);
        const isEligible = eligiblePaymentMethods.some(pm => pm.code === stripePaymentMethod.code);
        if (!isEligible) {
            throw new UserInputError(`Stripe payment method is not eligible for order ${order.code}`);
        }
        const { apiKey, webhookSecret } = this.getCredentials(stripePaymentMethod);
        return new VendureStripeClient(
            apiKey,
            webhookSecret,
            this.options.apiVersion,
            this.options.httpClient,
        );
    }

    private async findEnabledStripePaymentMethod(ctx: RequestContext): Promise<PaymentMethod> {
        const paymentMethods = await this.paymentMethodService.findAll(ctx, {
            filter: {
                enabled: { eq: true },
            },
        });
        const stripePaymentMethod = paymentMethods.items.find(
            pm => pm.handler.code === stripePaymentMethodHandler.code,
        );
        if (!stripePaymentMethod) {
            throw new UserInputError('No enabled Stripe payment method found');
        }
        return stripePaymentMethod;
    }

    private getCredentials(paymentMethod: PaymentMethod): { apiKey: string; webhookSecret: string } {
        const { apiKey, webhookSecret } = stripePaymentMethodHandler.resolveArgs(paymentMethod.handler.args);
        this.assertNotEncrypted('apiKey', apiKey);
        this.assertNotEncrypted('webhookSecret', webhookSecret);
        if (!apiKey) {
            throw Error(`No argument named 'apiKey' found!`);
        }
        if (!webhookSecret) {
            throw Error(`No argument named 'webhookSecret' found!`);
        }
        return { apiKey, webhookSecret };
    }

    /**
     * Without `encryptSecrets`, core does not decrypt the credentials, so a value encrypted while the
     * option was on would be sent to Stripe as ciphertext and fail as an authentication error.
     */
    private assertNotEncrypted(name: string, value: string | undefined): void {
        if (this.options.encryptSecrets || !value) {
            return;
        }
        // `encryptionStrategy` exists from Vendure 3.8; the plugin also supports older versions.
        const { encryptionStrategy } = this.configService.systemOptions as {
            encryptionStrategy?: { isEncrypted(value: string): boolean };
        };
        if (encryptionStrategy?.isEncrypted(value)) {
            throw new Error(
                `The Stripe '${name}' is stored encrypted, but the StripePlugin \`encryptSecrets\` option ` +
                    'is not enabled. Enable the option, or enter the credential again on the Stripe payment method.',
            );
        }
    }

    /**
     * Resolves the optional per-request options (e.g. a `stripeAccount` targeting a
     * connected account). Returns `undefined` when no callback is configured or it
     * yields an empty object, because the Stripe SDK rejects an empty options hash.
     */
    private async resolveRequestOptions(
        ctx: RequestContext,
        order: Order,
    ): Promise<StripeRequestOptions | undefined> {
        const additionalOptions = await this.options.requestOptions?.(
            new Injector(this.moduleRef),
            ctx,
            order,
        );
        return additionalOptions && Object.keys(additionalOptions).length > 0
            ? additionalOptions
            : undefined;
    }

    /**
     * Returns the stripeCustomerId if the Customer has one. If that's not the case, queries Stripe to check
     * if the customer is already registered, in which case it saves the id as stripeCustomerId and returns it.
     * Otherwise, creates a new Customer record in Stripe and returns the generated id.
     */
    private async getStripeCustomerId(
        ctx: RequestContext,
        activeOrder: Order,
        requestOptions?: StripeRequestOptions,
    ): Promise<string | undefined> {
        const [stripe, order] = await Promise.all([
            this.getStripeClient(ctx, activeOrder),
            // Load relation with customer not available in the response from activeOrderService.getOrderFromContext().
            // The object form of `relations` works on TypeORM 0.3 and v1; the string-array form was removed in v1.
            this.connection.getRepository(ctx, Order).findOne({
                where: { id: activeOrder.id },
                relations: { customer: true },
            }),
        ]);

        if (!order || !order.customer) {
            // This should never happen
            return undefined;
        }

        const { customer } = order;

        if (customer.customFields.stripeCustomerId) {
            return customer.customFields.stripeCustomerId;
        }

        let stripeCustomerId;

        // The customer lookup and creation must hit the same Stripe account as the
        // PaymentIntent. When `requestOptions` carries a `stripeAccount`, omitting it
        // here would create the customer on the platform account while the intent
        // targets the connected account, surfacing as "No such customer".
        const stripeCustomers = await stripe.customers.list(
            { email: customer.emailAddress },
            requestOptions,
        );
        if (stripeCustomers.data.length > 0) {
            stripeCustomerId = stripeCustomers.data[0].id;
        } else {
            const additionalParams = await this.options.customerCreateParams?.(
                new Injector(this.moduleRef),
                ctx,
                order,
            );
            const newStripeCustomer = await stripe.customers.create(
                {
                    email: customer.emailAddress,
                    name: `${customer.firstName} ${customer.lastName}`,
                    ...(additionalParams ?? {}),
                    ...(additionalParams?.metadata
                        ? { metadata: sanitizeMetadata(additionalParams.metadata) }
                        : {}),
                },
                requestOptions,
            );

            stripeCustomerId = newStripeCustomer.id;

            Logger.info(`Created Stripe Customer record for customerId ${customer.id}`, loggerCtx);
        }

        customer.customFields.stripeCustomerId = stripeCustomerId;
        await this.connection.getRepository(ctx, Customer).save(customer, { reload: false });

        return stripeCustomerId;
    }
}
