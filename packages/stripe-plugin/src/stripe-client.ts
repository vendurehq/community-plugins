import Stripe from 'stripe';

import { StripeHttpClient, StripeLatestApiVersion } from './stripe-types';

/**
 * Wrapper around the Stripe client that exposes ApiKey and WebhookSecret.
 *
 * `apiVersion` controls the Stripe API version sent with every request:
 *   - `undefined` (default) — use the SDK's pinned version (recommended).
 *   - a specific version string — pin to that version (cast to
 *     `StripeLatestApiVersion`).
 *
 * Note: the underlying SDK coerces `null`/falsy to its pinned default
 * (`stripe.core.js`: `props.apiVersion || DEFAULT_API_VERSION`), so there
 * is no way to instruct it to omit the `Stripe-Version` header and use the
 * Stripe account's default API version. This was true on stripe-node v13
 * too, despite a misleading comment in the pre-2.0.0 plugin code.
 *
 * `httpClient` overrides the underlying HTTP transport. When it is not set,
 * the SDK uses its default Node client (`node:http`/`node:https`).
 */
export class VendureStripeClient extends Stripe {
    constructor(
        private apiKey: string,
        public webhookSecret: string,
        apiVersion?: StripeLatestApiVersion,
        httpClient?: StripeHttpClient,
    ) {
        super(apiKey, {
            apiVersion,
            httpClient,
            // Retry requests that fail due to a network error or a transient Stripe error (5xx/429).
            // The SDK attaches idempotency keys to the retries, so a retried capture, cancel or
            // refund never double-acts on the PaymentIntent.
            maxNetworkRetries: 2,
        });
    }
}
