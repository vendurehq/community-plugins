/**
 * Aliases for the Stripe SDK types the plugin uses, derived from the client's
 * method signatures. They were added because stripe@22 did not expose its
 * namespace types (`Stripe.PaymentIntent` etc.) through the default import under
 * `moduleResolution: NodeNext` + CommonJS
 * (https://github.com/stripe/stripe-node/issues/2683). stripe@23 does, so the
 * internal aliases could be replaced with direct namespace access.
 * `StripeHttpClient` and `StripeLatestApiVersion` are exported from the plugin
 * and must stay.
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
