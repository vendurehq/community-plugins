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

                // In manual-capture mode `succeeded` fires after the plugin captures and `canceled`
                // after it voids, so both merely confirm an action already taken here.
                if (isManualCapture && event.type === 'payment_intent.succeeded') {
                    Logger.info(`Capture confirmed for order ${orderCode} (${paymentIntent.id})`, loggerCtx);
                    return;
                }
                if (isManualCapture && event.type === 'payment_intent.canceled') {
                    Logger.info(`Authorization voided for order ${orderCode} (${paymentIntent.id})`, loggerCtx);
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
                        }
                        return;
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
                    }
                    return;
                }

                // The payment intent ID is added to the order only if we can reach this point.
                Logger.info(
                    `Stripe payment intent id ${paymentIntent.id} added to order ${orderCode}`,
                    loggerCtx,
                );

                if (isManualCapture) {
                    // The order is now in PaymentAuthorized and stock has been allocated, so it is safe
                    // to capture the held funds by settling the payment (moving it to PaymentSettled).
                    const authorizedPayment = await this.connection.getRepository(ctx, Payment).findOne({
                        where: { transactionId: paymentIntent.id },
                    });
                    if (authorizedPayment) {
                        const settleResult = await this.orderService.settlePayment(ctx, authorizedPayment.id);
                        // `settlePayment` returns the settled Payment on success and an error result
                        // otherwise, never an Order.
                        if (isGraphQlErrorResult(settleResult)) {
                            // Capture failed after a successful authorization. The order stays in
                            // PaymentAuthorized with the funds still held, so it can be captured or
                            // cancelled from the Admin UI. Do not void here.
                            Logger.error(
                                `Authorized order ${orderCode} but could not capture payment ${paymentIntent.id}: ${
                                    'paymentErrorMessage' in settleResult && settleResult.paymentErrorMessage
                                        ? settleResult.paymentErrorMessage
                                        : settleResult.message
                                }`,
                                loggerCtx,
                            );
                        }
                    }
                }
            });
        } catch (e: any) {
            // An unexpected/transient error (for example a database issue) rolled back the
            // transaction. Respond with a 5xx so Stripe redelivers the event and we get another
            // chance to process it; the idempotency guard above makes redelivery safe. We do not void
            // here on purpose: a transient failure must not discard a valid authorization. Genuine
            // "cannot arrange the order" outcomes are handled deterministically above (they void and
            // return 200), so they are not retried.
            Logger.error(
                `Error processing Stripe webhook for order ${orderCode}: ${(e as Error)?.message}`,
                loggerCtx,
            );
            if (!response.headersSent) {
                response.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Error processing webhook');
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
