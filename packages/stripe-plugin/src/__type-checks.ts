/**
 * Compile-time tripwire for the workarounds in `stripe-types.ts`.
 *
 * That file extracts namespace types from stripe-node's method signatures
 * (a workaround for https://github.com/stripe/stripe-node/issues/2683 /
 * https://github.com/stripe/stripe-node/pull/2725 — CJS+NodeNext doesn't
 * expose the `Stripe.*` namespace via the default import).
 *
 * If a future stripe-node release reshapes the underlying method signatures
 * — even subtly, e.g. by tightening overloads — the shimmed types here can
 * drift silently. The assertions below pin the specific fields the plugin
 * reads/writes against the shimmed types, so any drift breaks the build
 * rather than the runtime.
 *
 * Delete this file when stripe-node#2725 ships and the shim itself can be
 * deleted.
 */
import type {
    StripeCustomerCreateParams,
    StripeEvent,
    StripeHttpClient,
    StripeLatestApiVersion,
    StripeMetadata,
    StripeMetadataParam,
    StripePaymentIntent,
    StripePaymentIntentCreateParams,
    StripeRefund,
    StripeRefundCreateParams,
    StripeRequestOptions,
} from './stripe-types';
import Stripe from 'stripe';


type Extends<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;

// PaymentIntent fields read by the plugin (controller + service).
type _PaymentIntent = Assert<
    Extends<StripePaymentIntent['id'], string> extends true
        ? Extends<NonNullable<StripePaymentIntent['client_secret']>, string> extends true
            ? Extends<StripePaymentIntent['amount_received'], number> extends true
                ? Extends<StripePaymentIntent['status'], string> extends true
                    ? Extends<NonNullable<StripePaymentIntent['metadata']>, Record<string, string>> extends true
                        ? Extends<
                              NonNullable<StripePaymentIntent['last_payment_error']>['message'],
                              string | undefined
                          > extends true
                            ? true
                            : false
                        : false
                    : false
                : false
            : false
        : false
>;

// PaymentIntentCreateParams fields written by the plugin (service.createPaymentIntent).
type _PaymentIntentCreateParams = Assert<
    Extends<StripePaymentIntentCreateParams['amount'], number> extends true
        ? Extends<StripePaymentIntentCreateParams['currency'], string> extends true
            ? Extends<
                  NonNullable<StripePaymentIntentCreateParams['automatic_payment_methods']>['enabled'],
                  boolean
              > extends true
                ? Extends<
                      NonNullable<StripePaymentIntentCreateParams['metadata']>,
                      Record<string, string | number | null>
                  > extends true
                    ? true
                    : false
                : false
            : false
        : false
>;

// CustomerCreateParams fields written by the plugin (service.getStripeCustomerId).
type _CustomerCreateParams = Assert<
    Extends<NonNullable<StripeCustomerCreateParams['email']>, string> extends true
        ? Extends<NonNullable<StripeCustomerCreateParams['name']>, string> extends true
            ? true
            : false
        : false
>;

// Refund fields read by the handler (stripe.handler.createRefund).
type _Refund = Assert<
    // status must include the three values the handler switches on.
    Extends<'succeeded', StripeRefund['status']> extends true
        ? Extends<'pending', StripeRefund['status']> extends true
            ? Extends<'failed', StripeRefund['status']> extends true
                ? Extends<StripeRefund['failure_reason'], string | undefined | null> extends true
                    ? true
                    : false
                : false
            : false
        : false
>;

// RefundCreateParams fields written by the plugin (service.createRefund).
type _RefundCreateParams = Assert<
    Extends<NonNullable<StripeRefundCreateParams['payment_intent']>, string> extends true
        ? Extends<NonNullable<StripeRefundCreateParams['amount']>, number> extends true
            ? // The structured reason enum must still accept the three values the service maps to.
              Extends<'requested_by_customer', NonNullable<StripeRefundCreateParams['reason']>> extends true
                ? Extends<'duplicate', NonNullable<StripeRefundCreateParams['reason']>> extends true
                    ? Extends<'fraudulent', NonNullable<StripeRefundCreateParams['reason']>> extends true
                        ? true
                        : false
                    : false
                : false
            : false
        : false
>;

// RequestOptions fields used by the plugin (service.createPaymentIntent + .createRefund).
type _RequestOptions = Assert<
    Extends<NonNullable<StripeRequestOptions['idempotencyKey']>, string> extends true
        ? Extends<NonNullable<StripeRequestOptions['stripeAccount']>, string> extends true
            ? true
            : false
        : false
>;

// Metadata-shaped types must remain a string-keyed record.
type _Metadata = Assert<
    Extends<StripeMetadata, Record<string, string>> extends true
        ? Extends<Record<string, string>, StripeMetadataParam> extends true
            ? true
            : false
        : false
>;

// Event fields read by the controller.
type _Event = Assert<
    Extends<StripeEvent['type'], string> extends true
        ? Extends<StripeEvent['id'], string> extends true
            ? true
            : false
        : false
>;

// API version must remain a string literal so cast targets stay valid.
type _ApiVersion = Assert<Extends<StripeLatestApiVersion, string>>;

// HttpClient must remain a value Stripe.createFetchHttpClient() produces.
type _HttpClient = Assert<Extends<ReturnType<typeof Stripe.createFetchHttpClient>, StripeHttpClient>>;

// Silence "is declared but never used" for the assertion locals — they exist
// for their compile-time effect only.
export type {
    _ApiVersion,
    _CustomerCreateParams,
    _Event,
    _HttpClient,
    _Metadata,
    _PaymentIntent,
    _PaymentIntentCreateParams,
    _Refund,
    _RefundCreateParams,
    _RequestOptions,
};
