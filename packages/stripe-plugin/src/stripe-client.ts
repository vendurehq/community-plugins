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
        });
    }
}
