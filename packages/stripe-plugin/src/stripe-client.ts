import Stripe from 'stripe';

import { StripeLatestApiVersion } from './stripe-types';

/**
 * Wrapper around the Stripe client that exposes ApiKey and WebhookSecret
 */
export class VendureStripeClient extends Stripe {
    constructor(private apiKey: string, public webhookSecret: string) {
        super(apiKey, {
            apiVersion: null as unknown as StripeLatestApiVersion, // Use accounts default version
        });
    }
}
