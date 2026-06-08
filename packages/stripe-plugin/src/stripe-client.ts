import Stripe from 'stripe';

import { StripeHttpClient, StripeLatestApiVersion } from './stripe-types';

/**
 * Wrapper around the Stripe client that exposes ApiKey and WebhookSecret.
 *
 * `apiVersion` controls the Stripe API version sent with every request:
 *   - `undefined` (default) — use the SDK's pinned version (recommended).
 *   - a specific version string — pin to that version.
 *   - `null` — fall back to the Stripe account's default API version
 *     (pre-2.0.0 behaviour).
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
        apiVersion?: StripeLatestApiVersion | null,
        httpClient?: StripeHttpClient,
    ) {
        super(apiKey, {
            apiVersion:
                apiVersion === null
                    ? (null as unknown as StripeLatestApiVersion)
                    : apiVersion,
            httpClient: httpClient ?? Stripe.createFetchHttpClient(),
        });
    }
}
