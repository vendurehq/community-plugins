import Stripe from 'stripe';

/**
 * Wrapper around the Stripe client that exposes ApiKey and WebhookSecret
 */
export class VendureStripeClient extends Stripe {
    constructor(private apiKey: string, public webhookSecret: string) {
        super(apiKey, {
            apiVersion: null as unknown as Stripe.LatestApiVersion, // Use accounts default version
            // Retry requests that fail due to a network error or a transient Stripe error (5xx/429).
            // The SDK attaches idempotency keys to the retries, so a retried capture or cancel never
            // double-acts on the PaymentIntent.
            maxNetworkRetries: 2,
        });
    }
}
