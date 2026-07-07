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
 * `httpClient` overrides the underlying HTTP transport. The default is
 * Stripe's fetch-based client (`globalThis.fetch`), which sidesteps a
 * deadlock between Stripe's NodeHttpClient and modern HTTP mocking
 * libraries (nock@14 / @mswjs/interceptors). Pass a NodeHttpClient with
 * a custom `http.Agent` to route through a proxy or tune keep-alive.
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
            httpClient: httpClient ?? Stripe.createFetchHttpClient(),
        });
    }
}
