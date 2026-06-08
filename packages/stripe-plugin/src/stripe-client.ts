import Stripe from 'stripe';

import { StripeLatestApiVersion } from './stripe-types';

/**
 * Wrapper around the Stripe client that exposes ApiKey and WebhookSecret.
 *
 * `apiVersion` controls the Stripe API version sent with every request:
 *   - `undefined` (default) — use the SDK's pinned version (recommended).
 *   - a specific version string — pin to that version.
 *   - `null` — fall back to the Stripe account's default API version
 *     (pre-2.0.0 behaviour).
 *
 * The underlying HTTP transport is Stripe's fetch-based client, using the
 * platform's global `fetch` (Node 18+). This avoids a deadlock between
 * Stripe's NodeHttpClient (which waits for the socket's `secureConnect`
 * event before writing the request body) and modern HTTP mocking libraries
 * such as nock@14 / @mswjs/interceptors, which only emit `secureConnect`
 * once a request has been matched and responded to.
 */
export class VendureStripeClient extends Stripe {
    constructor(
        private apiKey: string,
        public webhookSecret: string,
        apiVersion?: StripeLatestApiVersion | null,
    ) {
        super(apiKey, {
            apiVersion:
                apiVersion === null
                    ? (null as unknown as StripeLatestApiVersion)
                    : apiVersion,
            httpClient: Stripe.createFetchHttpClient(),
        });
    }
}
