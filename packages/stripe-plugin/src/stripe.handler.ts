import {
    CancelPaymentErrorResult,
    CancelPaymentResult,
    CreatePaymentResult,
    CreateRefundResult,
    Injector,
    LanguageCode,
    PaymentMethodHandler,
    SettlePaymentErrorResult,
    SettlePaymentResult,
} from '@vendure/core';
import Stripe from 'stripe';

import { getAmountFromStripeMinorUnits, isRetryableStripeError } from './stripe-utils';
import { StripeService } from './stripe.service';

const { StripeError } = Stripe.errors;

let stripeService: StripeService;

/**
 * The handler for Stripe payments.
 */
export const stripePaymentMethodHandler = new PaymentMethodHandler({
    code: 'stripe',

    description: [{ languageCode: LanguageCode.en, value: 'Stripe payments' }],

    args: {
        apiKey: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'API Key' }],
            ui: { component: 'password-form-input' },
        },
        webhookSecret: {
            type: 'string',
            label: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Webhook secret',
                },
            ],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Secret to validate incoming webhooks. Get this from your Stripe dashboard',
                },
            ],
            ui: { component: 'password-form-input' },
        },
    },

    init(injector: Injector) {
        stripeService = injector.get(StripeService);
    },

    createPayment(ctx, order, amount, ___, metadata): CreatePaymentResult {
        // By the time the webhook in stripe.controller.ts adds the payment to the order, the funds
        // are either already captured (automatic capture) or authorized and held (manual capture).
        if (ctx.apiType !== 'admin') {
            throw Error(`CreatePayment is not allowed for apiType '${ctx.apiType}'`);
        }
        const amountInMinorUnits = getAmountFromStripeMinorUnits(order, metadata.paymentIntentAmountReceived);
        return {
            amount: amountInMinorUnits,
            // In manual-capture mode the funds are only authorized at this point, so the payment
            // starts as `Authorized`; `settlePayment` captures it. In automatic mode the funds are
            // already captured, so the payment is `Settled` immediately (the historic behaviour).
            state: stripeService.isManualCapture() ? ('Authorized' as const) : ('Settled' as const),
            transactionId: metadata.paymentIntentId,
            metadata,
        };
    },

    async settlePayment(ctx, order, payment): Promise<SettlePaymentResult | SettlePaymentErrorResult> {
        if (!stripeService.isManualCapture()) {
            // Automatic capture: Stripe already captured the funds before the payment was added, so
            // settling on the Vendure side is a no-op.
            return { success: true };
        }
        // Manual capture: charge the funds that were authorized at `createPayment` time.
        try {
            const captured = await stripeService.capturePaymentIntent(ctx, order, payment.transactionId);
            if (captured.status === 'succeeded' || captured.status === 'processing') {
                return { success: true };
            }
            return {
                success: false,
                errorMessage: `Could not capture PaymentIntent ${payment.transactionId}, status is '${captured.status}'`,
            };
        } catch (e: any) {
            // A temporary error must not be recorded as a failed settlement: Vendure would move the
            // payment to `Error`, which can't be settled again, and the authorization would be stuck.
            // Throwing rolls back the caller's transaction instead, so the payment stays `Authorized`
            // and the capture can be retried (the webhook returns 5xx and Stripe redelivers it).
            if (isRetryableStripeError(e)) {
                throw e;
            }
            if (e instanceof StripeError) {
                return { success: false, errorMessage: e.message };
            }
            throw e;
        }
    },

    async cancelPayment(ctx, order, payment): Promise<CancelPaymentResult | CancelPaymentErrorResult> {
        if (!stripeService.isManualCapture()) {
            // Automatic capture has no authorization hold to release, so this preserves the historic
            // behaviour of cancelling the Vendure payment without calling Stripe.
            return { success: true };
        }
        // Manual capture: void the authorization so the held funds are released without a charge.
        try {
            const cancelled = await stripeService.cancelPaymentIntent(ctx, order, payment.transactionId);
            if (cancelled.status === 'canceled') {
                return { success: true };
            }
            return {
                success: false,
                errorMessage: `Could not cancel PaymentIntent ${payment.transactionId}, status is '${cancelled.status}'`,
            };
        } catch (e: any) {
            // As in `settlePayment`, a temporary error leaves the payment as it is so it can be retried.
            if (isRetryableStripeError(e)) {
                throw e;
            }
            if (e instanceof StripeError) {
                return { success: false, errorMessage: e.message };
            }
            throw e;
        }
    },

    async createRefund(ctx, input, amount, order, payment, args): Promise<CreateRefundResult> {
        // TODO: Consider passing the "reason" property once this feature request is addressed:
        // https://github.com/vendurehq/vendure/issues/893
        try {
            const refund = await stripeService.createRefund(ctx, order, payment, amount);
            if (refund.status === 'succeeded') {
                return {
                    state: 'Settled' as const,
                    transactionId: payment.transactionId,
                };
            }

            if (refund.status === 'pending') {
                return {
                    state: 'Pending' as const,
                    transactionId: payment.transactionId,
                };
            }

            return {
                state: 'Failed' as const,
                transactionId: payment.transactionId,
                metadata: {
                    message: refund.failure_reason,
                },
            };
        } catch (e: any) {
            if (e instanceof StripeError) {
                return {
                    state: 'Failed' as const,
                    transactionId: payment.transactionId,
                    metadata: {
                        type: e.type,
                        message: e.message,
                    },
                };
            }
            throw e;
        }
    },
});
