/**
 * Re-exports for Stripe namespace types that are unreachable via the default
 * import under `moduleResolution: NodeNext` + CommonJS in stripe@22's d.ts
 * shipping shape (see https://github.com/stripe/stripe-node/issues/2683 /
 * https://github.com/stripe/stripe-node/pull/2725). The PR is not yet merged
 * at the time of writing; once the upstream fix ships and we pin a version
 * that includes it, the rest of the plugin can switch back to direct
 * `Stripe.PaymentIntent`-style access and this file can be deleted.
 */
import type Stripe from 'stripe';

type StripeInstance = Stripe.Stripe;

export type StripePaymentIntent = Awaited<ReturnType<StripeInstance['paymentIntents']['create']>>;
export type StripePaymentIntentCreateParams = NonNullable<
    Parameters<StripeInstance['paymentIntents']['create']>[0]
>;
export type StripeCustomerCreateParams = NonNullable<
    Parameters<StripeInstance['customers']['create']>[0]
>;
export type StripeRefund = Awaited<ReturnType<StripeInstance['refunds']['create']>>;
export type StripeRefundCreateParams = NonNullable<Parameters<StripeInstance['refunds']['create']>[0]>;
export type StripeRequestOptions = NonNullable<Parameters<StripeInstance['paymentIntents']['create']>[1]>;
export type StripeMetadataParam = NonNullable<StripePaymentIntentCreateParams['metadata']>;
export type StripeMetadata = NonNullable<StripePaymentIntent['metadata']>;
export type StripeEvent = ReturnType<StripeInstance['webhooks']['constructEvent']>;
export type StripeLatestApiVersion = NonNullable<
    NonNullable<ConstructorParameters<typeof Stripe>[1]>['apiVersion']
>;
export type StripeHttpClient = NonNullable<
    NonNullable<ConstructorParameters<typeof Stripe>[1]>['httpClient']
>;
