/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { LanguageCode } from '@vendure/common/lib/generated-types';
import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN } from '@vendure/testing';
import nock from 'nock';
import fetch from 'node-fetch';
import path from 'path';
import { Stripe } from 'stripe';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { StripePlugin } from '../src';
import { stripePaymentMethodHandler } from '../src/stripe.handler';

import {
    createPaymentMethodDocument,
    getCustomerListDocument,
    getOrderPaymentsDocument,
} from './graphql/admin-definitions';
import { ResultOf } from './graphql/graphql-admin';
import { addItemToOrderDocument, getActiveOrderDocument } from './graphql/shop-definitions';
import { refundOrderLine, setShipping } from './payment-helpers';

const STRIPE_BASE_URL = 'https://api.stripe.com/';

/** Records the refund request the plugin sends, so a test can assert on its body and headers. */
function mockRefund() {
    const request: { body?: Record<string, string>; stripeAccount?: unknown } = {};
    nock(STRIPE_BASE_URL)
        .post('/v1/refunds', body => {
            request.body = body;
            return true;
        })
        .reply(function () {
            request.stripeAccount = this.req.headers['stripe-account'];
            return [200, { id: 're_test', status: 'succeeded' }];
        });
    return request;
}

describe('Stripe refunds', () => {
    const devConfig = mergeConfig(testConfig(), { plugins: [StripePlugin.init({})] });
    const { shopClient, adminClient, server } = createTestEnvironment(devConfig);
    let serverPort: number;
    let customers: ResultOf<typeof getCustomerListDocument>['customers']['items'];

    beforeAll(async () => {
        serverPort = devConfig.apiOptions.port;
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
            customerCount: 6,
        });
        await adminClient.asSuperAdmin();
        ({
            customers: { items: customers },
        } = await adminClient.query(getCustomerListDocument, { options: { take: 6 } }));
        // Any Stripe call without a mock fails the test instead of reaching the network.
        nock.disableNetConnect();
        nock.enableNetConnect(/(localhost|127\.0\.0\.1)/);
        await adminClient.query(createPaymentMethodDocument, {
            input: {
                code: `stripe-payment-${E2E_DEFAULT_CHANNEL_TOKEN}`,
                translations: [
                    {
                        name: 'Stripe refund test',
                        description: 'Stripe test payment method (refunds)',
                        languageCode: LanguageCode.en,
                    },
                ],
                enabled: true,
                handler: {
                    code: stripePaymentMethodHandler.code,
                    arguments: [
                        { name: 'apiKey', value: 'test-api-key' },
                        { name: 'webhookSecret', value: 'test-signing-secret' },
                    ],
                },
            },
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterEach(() => {
        nock.cleanAll();
        StripePlugin.options.requestOptions = undefined;
    });

    afterAll(async () => {
        nock.enableNetConnect();
        await server.destroy();
    });

    /** Pays an order through the `payment_intent.succeeded` webhook and returns what a refund needs. */
    async function settledPayment(customerIndex: number, paymentIntentId: string) {
        await shopClient.asUserWithCredentials(customers[customerIndex].emailAddress, 'test');
        await shopClient.query(addItemToOrderDocument, { productVariantId: 'T_1', quantity: 2 });
        await setShipping(shopClient);
        const { activeOrder } = await shopClient.query(getActiveOrderDocument);
        const body = JSON.stringify({
            id: `evt_${paymentIntentId}`,
            object: 'event',
            api_version: '2022-11-15',
            data: {
                object: {
                    id: paymentIntentId,
                    currency: 'usd',
                    metadata: {
                        orderCode: activeOrder!.code,
                        orderId: parseInt(activeOrder!.id.replace('T_', ''), 10),
                        channelToken: E2E_DEFAULT_CHANNEL_TOKEN,
                    },
                    amount_received: activeOrder!.totalWithTax,
                    status: 'succeeded',
                },
            },
            livemode: false,
            pending_webhooks: 1,
            request: { id: 'req_0', idempotency_key: null },
            type: 'payment_intent.succeeded',
        });
        const header = new Stripe('test-api-key', {
            apiVersion: '2023-08-16',
        }).webhooks.generateTestHeaderString({ payload: body, secret: 'test-signing-secret' });
        const result = await fetch(`http://localhost:${serverPort}/payments/stripe`, {
            method: 'post',
            body,
            headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
        });
        expect(result.status).toEqual(200);
        const { order } = await adminClient.query(getOrderPaymentsDocument, { id: activeOrder!.id });
        expect(order!.state).toEqual('PaymentSettled');
        return { order: activeOrder!, payment: order!.payments![0] };
    }

    it('sends only the payment intent and amount by default', async () => {
        const { order, payment } = await settledPayment(0, 'pi_default');
        const request = mockRefund();

        const refund = await refundOrderLine(adminClient, order.lines[0].id, 1, payment.id, 0);

        expect(refund.state).toEqual('Settled');
        expect(request.body).toEqual({
            payment_intent: 'pi_default',
            amount: String(refund.total),
        });
        expect(request.stripeAccount).toBeUndefined();
    });

    it('passes requestOptions to the refund, so it targets the same account as the intent', async () => {
        const { order, payment } = await settledPayment(1, 'pi_connected');
        StripePlugin.options.requestOptions = () => ({ stripeAccount: 'acct_connected' });
        const request = mockRefund();

        await refundOrderLine(adminClient, order.lines[0].id, 1, payment.id, 0);

        expect(request.stripeAccount).toEqual('acct_connected');
    });
});
