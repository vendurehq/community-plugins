import { Controller, Headers, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { PaymentMethod, RequestContext } from '@vendure/core';
import {
    ChannelService,
    ID,
    InternalServerError,
    isGraphQlErrorResult,
    LanguageCode,
    Logger,
    Order,
    OrderService,
    orderTotalIsCovered,
    Payment,
    PaymentMethodService,
    RequestContextService,
    TransactionalConnection,
} from '@vendure/core';
import { OrderStateTransitionError } from '@vendure/core/dist/common/error/generated-graphql-shop-errors';
import type { Response } from 'express';
import Stripe from 'stripe';

import { loggerCtx, STRIPE_PLUGIN_OPTIONS } from './constants';
import { isExpectedVendureStripeEventMetadata, isRetryableStripeError } from './stripe-utils';
import { stripePaymentMethodHandler } from './stripe.handler';
import { StripeService } from './stripe.service';
import { RequestWithRawBody, StripePluginOptions } from './types';

const missingHeaderErrorMessage = 'Missing stripe-signature header';
const signatureErrorMessage = 'Error verifying Stripe webhook signature';
const noPaymentIntentErrorMessage = 'No payment intent in the event payload';
const ignorePaymentIntentEvent = 'Event has no Vendure metadata, skipped.';

/**
 * Thrown inside the webhook transaction to roll back a payment whose authorization will be voided.
 */
class AuthorizationNotUsableError extends Error {}

@Controller('payments')
export class StripeController {
    /**
     * Per-order mutex chains serializing webhook settlement within this
     * process. The row lock inside the transaction covers overlap across
     * processes, but SQLite-family drivers skip it (see lockOrderForUpdate) —
     * and the e2e suite runs on sqljs — so same-process overlap is
     * serialized here instead.
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

        const isManualCapture = this.stripeService.isManualCapture();
        // With manual capture the authorization arrives as `amount_capturable_updated` (funds held,
        // status `requires_capture`); with automatic capture the funds are already charged and the
        // event is `succeeded`.
        const authorizationEventType = isManualCapture
            ? 'payment_intent.amount_capturable_updated'
            : 'payment_intent.succeeded';

        // Set when an authorization was placed but the order could not be arranged (for example the
        // item sold out). The hold is released after the transaction settles/rolls back.
        let orderForVoid: Order | undefined;
        let shouldVoidAuthorization = false;
        // Set when the payment is recorded as `Authorized` and the funds still have to be captured.
        // Stripe is only called once the transaction that recorded the payment has committed, so a
        // capture can never succeed while Vendure rolls back the payment.
        let orderToCapture: Order | undefined;

        const releaseSettlementLock = await this.acquireOrderSettlementLock(orderCode);
        try {
            await this.connection.withTransaction(outerCtx, async (ctx: RequestContext) => {
                // Serialize webhook processing per order: a concurrent delivery of the same event
                // waits here until this one commits, then finds the recorded payment below and does
                // nothing. This must be the first read in the transaction: under REPEATABLE READ (the
                // MySQL/MariaDB default) later plain reads see a snapshot taken at the first read, so
                // locking first is what lets them see a payment the other delivery just committed.
                await this.lockOrderForUpdate(ctx, orderId);

                const order = await this.orderService.findOneByCode(ctx, orderCode);

                if (!order) {
                    throw new Error(
                        `Unable to find order ${orderCode}, unable to settle payment ${paymentIntent.id}!`,
                    );
                }
                orderForVoid = order;

                // The secret was resolved without the order; run the unchanged
                // eligibility gate now that the order is known.
                await this.stripeService.getStripeClient(ctx, order);

                if (event.type === 'payment_intent.payment_failed') {
                    const message = paymentIntent.last_payment_error?.message ?? 'unknown error';
                    Logger.warn(`Payment for order ${orderCode} failed: ${message}`, loggerCtx);
                    response.status(HttpStatus.OK).send('Ok');
                    return;
                }

                // In manual-capture mode `succeeded` fires after the funds were captured. Normally the
                // capture step below has settled the payment already, but if the process stopped
                // between the capture and the settlement the payment is still `Authorized`, so settle
                // it here. Nothing is done for a payment that is already settled, which makes
                // redeliveries and the race with the capture step harmless.
                if (isManualCapture && event.type === 'payment_intent.succeeded') {
                    const settled = await this.settleCapturedPayment(ctx, orderCode, paymentIntent.id);
                    if (!settled) {
                        Logger.info(
                            `Capture confirmed for order ${orderCode} (${paymentIntent.id}), no payment to settle`,
                            loggerCtx,
                        );
                    }
                    return;
                }
                // In manual-capture mode `canceled` fires when the authorization is voided, either by
                // the plugin or the Admin UI (the payment is then already gone or `Cancelled`) or by
                // Stripe when the authorization expires before it was captured. In the last case the
                // payment is still `Authorized`, so cancel it here.
                if (isManualCapture && event.type === 'payment_intent.canceled') {
                    const cancelled = await this.cancelVoidedPayment(ctx, orderCode, paymentIntent.id);
                    if (!cancelled) {
                        Logger.info(
                            `Authorization voided for order ${orderCode} (${paymentIntent.id}), no payment to cancel`,
                            loggerCtx,
                        );
                    }
                    return;
                }

                if (event.type !== authorizationEventType) {
                    // The webhook should be configured to send only the events handled above, so
                    // anything else is unexpected and safely ignored.
                    Logger.info(`Received ${event.type} status update for order ${orderCode}`, loggerCtx);
                    return;
                }

                // Idempotency: a repeated authorization webhook must not add a second payment or void
                // a valid one, so do nothing if this intent is already recorded on an order.
                const existingPayment = await this.connection.getRepository(ctx, Payment).findOne({
                    where: { transactionId: paymentIntent.id },
                });
                if (existingPayment) {
                    if (isManualCapture && existingPayment.state === 'Authorized') {
                        // An earlier delivery recorded the authorization but did not get to capture
                        // it (a temporary Stripe error, or the process stopped), so pick up from there,
                        // unless the order has moved on since (for example it was cancelled).
                        if (!(await this.isReadyForCapture(ctx, order))) {
                            Logger.error(
                                `Payment for intent ${paymentIntent.id} is authorized but order ${orderCode} is '${order.state}', not capturing`,
                                loggerCtx,
                            );
                            return;
                        }
                        Logger.info(
                            `Payment for intent ${paymentIntent.id} is still authorized, resuming capture for order ${orderCode}`,
                            loggerCtx,
                        );
                        orderToCapture = order;
                        return;
                    }
                    Logger.info(
                        `Payment for intent ${paymentIntent.id} already recorded, skipping order ${orderCode}`,
                        loggerCtx,
                    );
                    return;
                }

                if (isManualCapture) {
                    // The event payload is a snapshot taken when the event was created. A redelivered
                    // authorization event can describe an intent that has since been voided (for
                    // example the void went through but its response was lost), so act on the
                    // intent's live state rather than arranging the order for a hold that is gone.
                    const liveIntent = await this.stripeService.retrievePaymentIntent(
                        ctx,
                        order,
                        paymentIntent.id,
                    );
                    if (liveIntent.status !== 'requires_capture' && liveIntent.status !== 'succeeded') {
                        Logger.info(
                            `PaymentIntent ${paymentIntent.id} for order ${orderCode} is '${liveIntent.status}', nothing to authorize`,
                            loggerCtx,
                        );
                        return;
                    }
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

                    // If the order is still not in the ArrangingPayment state, it cannot be paid. The
                    // default order process blocks this transition when the order is no longer
                    // saleable (backorder-aware, via `arrangingPaymentRequiresStock`), among other
                    // preconditions, so this is the point at which "the item sold out during
                    // checkout" surfaces. With manual capture the funds are only authorized, so we
                    // void the hold instead of leaving the customer charged for an order that cannot
                    // be arranged.
                    if (transitionToStateResult instanceof OrderStateTransitionError) {
                        Logger.error(
                            `Error transitioning order ${orderCode} to ArrangingPayment state: ${transitionToStateResult.message}`,
                            loggerCtx,
                        );
                        if (isManualCapture) {
                            shouldVoidAuthorization = true;
                            return;
                        }
                        // Automatic capture: the funds are already charged, so failing
                        // silently with a 200 would leave the order unsettled with no
                        // retry. Throw so the catch below answers 5xx and Stripe
                        // redelivers; the idempotency guard makes redelivery safe.
                        throw new InternalServerError(
                            `Stripe settlement failed for order ${orderCode}: could not transition to ArrangingPayment`,
                        );
                    }
                }

                const paymentMethod = await this.getPaymentMethod(ctx);

                // With manual capture the funds are only authorized, so `amount_received` is still 0;
                // record the capturable amount instead.
                const paymentAmountReceived = isManualCapture
                    ? paymentIntent.amount_capturable || paymentIntent.amount
                    : paymentIntent.amount_received;

                const addPaymentToOrderResult = await this.orderService.addPaymentToOrder(ctx, orderId, {
                    method: paymentMethod.code,
                    metadata: {
                        paymentIntentAmountReceived: paymentAmountReceived,
                        paymentIntentId: paymentIntent.id,
                    },
                });

                if (!(addPaymentToOrderResult instanceof Order)) {
                    Logger.error(
                        `Error adding payment to order ${orderCode}: ${addPaymentToOrderResult.message}`,
                        loggerCtx,
                    );
                    // Manual capture: the funds are authorized but Vendure rejected the payment (for
                    // example the item sold out), so the hold must be released.
                    if (isManualCapture) {
                        shouldVoidAuthorization = true;
                        return;
                    }
                    // Automatic capture: see the transition failure above — fail the
                    // request so Stripe retries instead of recording it as delivered.
                    throw new InternalServerError(
                        `Stripe settlement failed for order ${orderCode}: ${addPaymentToOrderResult.message}`,
                    );
                }

                if (isManualCapture && !(await this.isReadyForCapture(ctx, addPaymentToOrderResult))) {
                    // The payment does not cover the order total, typically because the cart changed
                    // after the intent was created and the customer confirmed the old client secret.
                    // Vendure leaves such an order in ArrangingPayment without allocating stock, so the
                    // funds must not be captured. Roll back the payment and void the hold instead.
                    Logger.error(
                        `Authorization ${paymentIntent.id} does not cover order ${orderCode} (state '${addPaymentToOrderResult.state}'), voiding it`,
                        loggerCtx,
                    );
                    shouldVoidAuthorization = true;
                    throw new AuthorizationNotUsableError();
                }

                // The payment intent ID is added to the order only if we can reach this point.
                Logger.info(
                    `Stripe payment intent id ${paymentIntent.id} added to order ${orderCode}`,
                    loggerCtx,
                );

                if (isManualCapture) {
                    // The order is now in PaymentAuthorized and stock has been allocated. The funds are
                    // captured after this transaction commits, see below.
                    orderToCapture = order;
                }
            });
        } catch (e: any) {
            if (!(e instanceof AuthorizationNotUsableError)) {
                // An unexpected/transient error (for example a database issue) rolled back the
                // transaction. Respond with a 5xx so Stripe redelivers the event and we get another
                // chance to process it; the idempotency guard above makes redelivery safe. We do not
                // void here on purpose: a transient failure must not discard a valid authorization.
                // Genuine "cannot arrange the order" outcomes are handled deterministically above
                // (they void and return 200), so they are not retried.
                Logger.error(
                    `Error processing Stripe webhook for order ${orderCode}: ${(e as Error)?.message}`,
                    loggerCtx,
                );
                if (!response.headersSent) {
                    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Error processing webhook');
                }
            }
            // Otherwise the payment was rolled back on purpose and the hold is voided below.
        } finally {
            releaseSettlementLock();
        }

        if (orderToCapture && !response.headersSent) {
            try {
                await this.captureAndSettle(outerCtx, orderToCapture, paymentIntent.id);
            } catch (e: any) {
                // The authorized payment is committed, so nothing is lost: respond with a 5xx so Stripe
                // redelivers the event, which resumes from the `Authorized` payment (and the
                // `payment_intent.succeeded` event settles it if the funds were captured already).
                Logger.error(
                    `Error capturing Stripe payment ${paymentIntent.id} for order ${orderCode}: ${
                        (e as Error)?.message
                    }`,
                    loggerCtx,
                );
                if (!response.headersSent) {
                    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Error capturing payment');
                }
            }
        }

        if (shouldVoidAuthorization && orderForVoid) {
            try {
                const voided = await this.stripeService.cancelPaymentIntent(
                    outerCtx,
                    orderForVoid,
                    paymentIntent.id,
                );
                if (voided.status === 'canceled') {
                    Logger.warn(
                        `Voided Stripe authorization ${paymentIntent.id} for order ${orderCode}: order could not be arranged`,
                        loggerCtx,
                    );
                } else {
                    // The intent can no longer be voided (for example it was captured in the
                    // meantime). Redelivering the event would not change that, so acknowledge it.
                    Logger.error(
                        `Could not void Stripe authorization ${paymentIntent.id} for order ${orderCode}: status is '${voided.status}'`,
                        loggerCtx,
                    );
                }
            } catch (e: any) {
                // The hold may still be in place. Respond with a 5xx so Stripe redelivers the event and
                // the void is retried. On redelivery, an intent that was in fact voided is recognised
                // from its live state and acknowledged.
                Logger.error(
                    `Failed to void Stripe authorization ${paymentIntent.id} for order ${orderCode}: ${
                        (e as Error)?.message
                    }`,
                    loggerCtx,
                );
                if (!response.headersSent) {
                    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Error voiding authorization');
                }
            }
        }

        // Send the response status only if we didn't sent anything yet.
        if (!response.headersSent) {
            response.status(HttpStatus.OK).send('Ok');
        }
    }

    /**
     * Captures the funds held for an `Authorized` payment and then settles the payment. Must be
     * called outside of any database transaction: Stripe is called first, so that a capture can
     * only be followed by a short, database-only transaction that records it.
     *
     * If the process stops after the capture, or the settlement fails, the payment stays
     * `Authorized` and is settled by the `payment_intent.succeeded` webhook or by a redelivery of
     * the authorization event. A temporary Stripe error is thrown so the webhook responds with a 5xx.
     */
    private async captureAndSettle(outerCtx: RequestContext, order: Order, paymentIntentId: string) {
        let captured: Stripe.PaymentIntent;
        try {
            captured = await this.stripeService.capturePaymentIntent(outerCtx, order, paymentIntentId);
        } catch (e: any) {
            if (e instanceof Stripe.errors.StripeError && !isRetryableStripeError(e)) {
                // Stripe refused the capture and repeating it would not change that. The payment stays
                // `Authorized` with the funds still held, so it can be captured or cancelled from the
                // Admin UI.
                Logger.error(
                    `Authorized order ${order.code} but could not capture payment ${paymentIntentId}: ${e.message}`,
                    loggerCtx,
                );
                return;
            }
            throw e;
        }
        if (captured.status !== 'succeeded' && captured.status !== 'processing') {
            Logger.error(
                `Authorized order ${order.code} but could not capture payment ${paymentIntentId}: status is '${captured.status}'`,
                loggerCtx,
            );
            return;
        }
        await this.connection.withTransaction(outerCtx, async ctx => {
            // Same lock as the webhook's first transaction: if the `succeeded` event got here first it
            // has already settled the payment, which `settleCapturedPayment` then leaves alone.
            await this.lockOrderForUpdate(ctx, order.id);
            await this.settleCapturedPayment(ctx, order.code, paymentIntentId);
        });
    }

    /**
     * Settles the payment for a PaymentIntent that Stripe has captured, but only if it is still
     * `Authorized`. Returns whether a payment was settled. Must run in a transaction that already
     * holds the order lock; it makes no Stripe calls.
     */
    private async settleCapturedPayment(
        ctx: RequestContext,
        orderCode: string,
        paymentIntentId: string,
    ): Promise<boolean> {
        const paymentRepository = this.connection.getRepository(ctx, Payment);
        const payment = await paymentRepository.findOne({ where: { transactionId: paymentIntentId } });
        if (!payment || payment.state !== 'Authorized') {
            return false;
        }
        // Tells the payment handler that the funds are captured, so settling doesn't call Stripe
        // again from inside this transaction.
        payment.metadata = { ...payment.metadata, paymentIntentCaptured: true };
        await paymentRepository.save(payment, { reload: false });
        const settleResult = await this.orderService.settlePayment(ctx, payment.id);
        // `settlePayment` returns the settled Payment on success and an error result otherwise,
        // never an Order.
        if (isGraphQlErrorResult(settleResult)) {
            Logger.error(
                `Captured payment ${paymentIntentId} for order ${orderCode} but could not settle it: ${
                    'paymentErrorMessage' in settleResult && settleResult.paymentErrorMessage
                        ? settleResult.paymentErrorMessage
                        : settleResult.message
                }`,
                loggerCtx,
            );
            return false;
        }
        Logger.info(`Settled payment ${paymentIntentId} for order ${orderCode}`, loggerCtx);
        return true;
    }

    /**
     * Whether the funds held for an order's `Authorized` payment may be captured. Vendure moves the
     * order to `PaymentAuthorized`, allocating stock, only once its payments cover the total. An
     * additional payment for a modified order leaves it in `ArrangingAdditionalPayment`, so there
     * the payments are checked directly.
     */
    private async isReadyForCapture(ctx: RequestContext, order: Order): Promise<boolean> {
        if (order.state === 'PaymentAuthorized') {
            return true;
        }
        if (order.state !== 'ArrangingAdditionalPayment') {
            return false;
        }
        order.payments = await this.orderService.getOrderPayments(ctx, order.id);
        return orderTotalIsCovered(order, ['Authorized', 'Settled']);
    }

    /**
     * Cancels the payment for a PaymentIntent that Stripe has cancelled, but only if it is still
     * `Authorized`. Returns whether a payment was cancelled. Must run in a transaction that already
     * holds the order lock; it makes no Stripe calls.
     */
    private async cancelVoidedPayment(
        ctx: RequestContext,
        orderCode: string,
        paymentIntentId: string,
    ): Promise<boolean> {
        const paymentRepository = this.connection.getRepository(ctx, Payment);
        const payment = await paymentRepository.findOne({ where: { transactionId: paymentIntentId } });
        if (!payment || payment.state !== 'Authorized') {
            return false;
        }
        // Tells the payment handler that the intent is cancelled already, so cancelling doesn't call
        // Stripe from inside this transaction.
        payment.metadata = { ...payment.metadata, paymentIntentCanceled: true };
        await paymentRepository.save(payment, { reload: false });
        const cancelResult = await this.orderService.cancelPayment(ctx, payment.id);
        if (isGraphQlErrorResult(cancelResult)) {
            Logger.error(
                `Stripe cancelled payment ${paymentIntentId} for order ${orderCode} but it could not be cancelled in Vendure: ${cancelResult.message}`,
                loggerCtx,
            );
            return false;
        }
        // Cancelling the payment does not release the order's stock; that happens when the order is
        // cancelled, which is left to the merchant (they may prefer to collect a new payment).
        Logger.warn(
            `Authorization ${paymentIntentId} for order ${orderCode} was cancelled in Stripe before it was captured, ` +
                `payment cancelled. Cancel the order to release its stock, or collect a new payment.`,
            loggerCtx,
        );
        return true;
    }

    /**
     * Takes a row lock on the order for the rest of the current transaction. Skipped on SQLite
     * drivers, which don't support row locks and only allow one writer at a time anyway.
     */
    private async lockOrderForUpdate(ctx: RequestContext, orderId: ID): Promise<void> {
        const driver = this.connection.rawConnection.options.type;
        if (driver === 'sqlite' || driver === 'sqljs' || driver === 'better-sqlite3') {
            return;
        }
        await this.connection.getRepository(ctx, Order).findOne({
            where: { id: orderId },
            lock: { mode: 'pessimistic_write' },
        });
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

    /**
     * Acquires the per-order settlement mutex, serializing overlapping
     * webhook deliveries within this process. The returned function releases
     * the mutex and must run once the settlement transaction settles (see
     * the `finally` at the call site) so a failed delivery cannot wedge
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

    private async getPaymentMethod(ctx: RequestContext): Promise<PaymentMethod> {
        const method = (await this.paymentMethodService.findAll(ctx)).items.find(
            m => m.handler.code === stripePaymentMethodHandler.code,
        );

        if (!method) {
            throw new InternalServerError(`[${loggerCtx}] Could not find Stripe PaymentMethod`);
        }

        return method;
    }
}
