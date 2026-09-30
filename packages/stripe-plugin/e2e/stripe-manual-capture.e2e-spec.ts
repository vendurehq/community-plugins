/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { CurrencyCode, GlobalFlag, LanguageCode } from '@vendure/common/lib/generated-types';
import { Logger, mergeConfig } from '@vendure/core';
import {
    createErrorResultGuard,
    createTestEnvironment,
    E2E_DEFAULT_CHANNEL_TOKEN,
    ErrorResultGuard,
} from '@vendure/testing';
import nock from 'nock';
import fetch from 'node-fetch';
import path from 'path';
import { Stripe } from 'stripe';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { StripePlugin } from '../src';
import { stripePaymentMethodHandler } from '../src/stripe.handler';

import {
    createPaymentMethodDocument,
    getCustomerListDocument,
    getOrderPaymentsDocument,
    updateProductVariantsDocument,
} from './graphql/admin-definitions';
import { ResultOf } from './graphql/graphql-admin';
import { FragmentOf } from './graphql/graphql-shop';
import { createStripePaymentIntentDocument } from './graphql/shared-definitions';
import { addItemToOrderDocument, getActiveOrderDocument, testOrderFragment } from './graphql/shop-definitions';
import { setShipping } from './payment-helpers';

const STRIPE_BASE_URL = 'https://api.stripe.com/';

/**
 * Builds and signs a Stripe webhook event so it passes signature validation in the controller.
 */
function signedWebhook(payload: object): { body: string; header: string } {
    const body = JSON.stringify(payload, null, 2);
    const header = new Stripe('test-api-key', { apiVersion: '2023-08-16' }).webhooks.generateTestHeaderString({
        payload: body,
        secret: 'test-signing-secret',
    });
    return { body, header };
}

async function postWebhook(serverPort: number, payload: object): Promise<number> {
    const { body, header } = signedWebhook(payload);
    const result = await fetch(`http://localhost:${serverPort}/payments/stripe`, {
        method: 'post',
        body,
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    });
    return result.status;
}

/** Mocks the live-state lookup the webhook does before acting on an authorization. */
function mockLiveIntent(id: string, status: Stripe.PaymentIntent.Status) {
    return nock(STRIPE_BASE_URL).get(`/v1/payment_intents/${id}`).reply(200, { id, status });
}

/**
 * A Stripe-side error on every attempt. The SDK retries 5xx responses (`maxNetworkRetries: 2`), so a
 * single call makes three requests.
 */
function mockStripeServerError(method: 'get' | 'post', requestPath: string) {
    return nock(STRIPE_BASE_URL)
        [method](requestPath)
        .times(3)
        .reply(500, { error: { type: 'api_error', message: 'Stripe is having a bad day' } });
}

function amountCapturableUpdatedEvent(order: FragmentOf<typeof testOrderFragment>, paymentIntentId: string) {
    return {
        id: `evt_${paymentIntentId}`,
        object: 'event',
        api_version: '2022-11-15',
        data: {
            object: {
                id: paymentIntentId,
                currency: 'usd',
                metadata: {
                    orderCode: order.code,
                    orderId: parseInt(order.id.replace('T_', ''), 10),
                    channelToken: E2E_DEFAULT_CHANNEL_TOKEN,
                },
                amount: order.totalWithTax,
                amount_capturable: order.totalWithTax,
                amount_received: 0,
                status: 'requires_capture',
            },
        },
        livemode: false,
        pending_webhooks: 1,
        request: { id: 'req_0', idempotency_key: null },
        type: 'payment_intent.amount_capturable_updated',
    };
}

describe('Stripe manual capture', () => {
    const devConfig = mergeConfig(testConfig(), {
        plugins: [
            StripePlugin.init({
                captureMethod: 'manual',
                // Return a conflicting capture_method from the create-params callback to prove the
                // plugin's captureMethod option is authoritative: every intent in this suite must
                // still be created with `capture_method: 'manual'` regardless of this value.
                paymentIntentCreateParams: () => ({ capture_method: 'automatic' }),
            }),
        ],
    });
    const { shopClient, adminClient, server } = createTestEnvironment(devConfig);
    let serverPort: number;
    let customers: ResultOf<typeof getCustomerListDocument>['customers']['items'];

    const orderGuard: ErrorResultGuard<FragmentOf<typeof testOrderFragment>> = createErrorResultGuard(
        input => !!input.lines,
    );

    async function adminOrder(orderId: string) {
        const { order } = await adminClient.query(getOrderPaymentsDocument, { id: orderId });
        return order!;
    }

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
                        name: 'Stripe manual capture test',
                        description: 'Stripe test payment method (manual capture)',
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
    });

    afterAll(async () => {
        nock.enableNetConnect();
        await server.destroy();
    });

    async function prepareOrder(customerIndex: number, productVariantId: string) {
        await shopClient.asUserWithCredentials(customers[customerIndex].emailAddress, 'test');
        const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
            productVariantId,
            quantity: 1,
        });
        orderGuard.assertSuccess(addItemToOrder);
        await setShipping(shopClient);
        // Re-read the order so its total includes shipping, which is what the intent would be for.
        const { activeOrder } = await shopClient.query(getActiveOrderDocument);
        return activeOrder!;
    }

    async function makeUnsaleable(productVariantId: string) {
        // Tracked, zero on hand and no backorder threshold, to simulate the item selling out during
        // checkout.
        await adminClient.query(updateProductVariantsDocument, {
            input: [
                {
                    id: productVariantId,
                    trackInventory: GlobalFlag.TRUE,
                    stockOnHand: 0,
                    useGlobalOutOfStockThreshold: false,
                    outOfStockThreshold: 0,
                },
            ],
        });
    }

    describe('creating the PaymentIntent', () => {
        beforeAll(async () => {
            await shopClient.asUserWithCredentials(customers[0].emailAddress, 'test');
            const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
                productVariantId: 'T_1',
                quantity: 1,
            });
            orderGuard.assertSuccess(addItemToOrder);
            await setShipping(shopClient);
        });

        it('creates the intent with capture_method manual (config overrides paymentIntentCreateParams)', async () => {
            let createBody: any;
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents', body => {
                    createBody = body;
                    return true;
                })
                .reply(200, { id: 'pi_manual', client_secret: 'pi_manual_secret', status: 'requires_payment_method' });
            // Reconcile-on-create retrieves the live intent to confirm it is still usable.
            nock(STRIPE_BASE_URL)
                .get('/v1/payment_intents/pi_manual')
                .reply(200, { id: 'pi_manual', client_secret: 'pi_manual_secret', status: 'requires_payment_method' });

            const { createStripePaymentIntent } = await shopClient.query(createStripePaymentIntentDocument);
            expect(createStripePaymentIntent).toEqual('pi_manual_secret');
            expect(createBody.capture_method).toEqual('manual');
        });

        it('replaces a cancelled intent under a key derived from it, so retries get the same replacement', async () => {
            const idempotencyKeys: string[] = [];
            function recordKey(this: any, _uri: string, _body: any) {
                idempotencyKeys.push(this.req.headers['idempotency-key']);
            }
            for (let i = 0; i < 2; i++) {
                // The idempotency key replays a previously cancelled intent...
                nock(STRIPE_BASE_URL)
                    .post('/v1/payment_intents')
                    .reply(function (uri, body) {
                        recordKey.call(this, uri, body);
                        return [200, { id: 'pi_dead', client_secret: 'pi_dead_secret', status: 'requires_payment_method' }];
                    });
                // ...whose live status is now `canceled`, so its secret is unusable...
                mockLiveIntent('pi_dead', 'canceled');
                // ...so the plugin asks for the replacement under a key derived from the cancelled
                // intent, which Stripe answers with the same replacement every time.
                nock(STRIPE_BASE_URL)
                    .post('/v1/payment_intents')
                    .reply(function (uri, body) {
                        recordKey.call(this, uri, body);
                        return [200, { id: 'pi_fresh', client_secret: 'pi_fresh_secret', status: 'requires_payment_method' }];
                    });
                nock(STRIPE_BASE_URL)
                    .get('/v1/payment_intents/pi_fresh')
                    .reply(200, { id: 'pi_fresh', client_secret: 'pi_fresh_secret', status: 'requires_payment_method' });

                const { createStripePaymentIntent } = await shopClient.query(createStripePaymentIntentDocument);
                expect(createStripePaymentIntent).toEqual('pi_fresh_secret');
            }
            const [rootKey, replacementKey, secondRootKey, secondReplacementKey] = idempotencyKeys;
            expect(replacementKey).toEqual(`${rootKey}_after_pi_dead`);
            // The retry used exactly the same keys, so Stripe replays the same replacement intent
            // instead of creating another one.
            expect(secondRootKey).toEqual(rootKey);
            expect(secondReplacementKey).toEqual(replacementKey);
        });

        it.each(['requires_capture', 'processing', 'succeeded'] as const)(
            'refuses to create another intent while the current one is %s',
            async status => {
                nock(STRIPE_BASE_URL)
                    .post('/v1/payment_intents')
                    .reply(200, { id: 'pi_held', client_secret: 'pi_held_secret', status: 'requires_payment_method' });
                nock(STRIPE_BASE_URL)
                    .get('/v1/payment_intents/pi_held')
                    .reply(200, { id: 'pi_held', client_secret: 'pi_held_secret', status });
                // No further create is mocked, so a second hold could not be placed even if the plugin
                // tried.
                await expect(shopClient.query(createStripePaymentIntentDocument)).rejects.toThrow(
                    /already authorized or completed/,
                );
            },
        );
    });

    describe('authorization webhook', () => {
        it('captures the funds when the order is still saleable', async () => {
            await shopClient.asUserWithCredentials(customers[0].emailAddress, 'test');
            const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
                productVariantId: 'T_1',
                quantity: 1,
            });
            orderGuard.assertSuccess(addItemToOrder);
            const order = addItemToOrder;
            await setShipping(shopClient);

            const liveScope = mockLiveIntent('pi_capture_ok', 'requires_capture');
            const captureScope = nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_capture_ok/capture')
                .reply(200, { id: 'pi_capture_ok', status: 'succeeded', amount_received: order.totalWithTax });

            const errorSpy = vi.spyOn(Logger, 'error');
            const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_capture_ok'));
            expect(status).toEqual(200);
            expect(liveScope.isDone()).toBe(true);
            // A successful capture must not be reported as a failure.
            expect(errorSpy.mock.calls.some(([message]) => String(message).includes('could not capture'))).toBe(false);
            errorSpy.mockRestore();
            // The plugin captured the authorized funds, so the order is settled.
            expect(captureScope.isDone()).toBe(true);
            const settled = await adminOrder(order.id);
            expect(settled.state).toEqual('PaymentSettled');
            const payment = settled.payments?.find(p => p.transactionId === 'pi_capture_ok');
            expect(payment?.state).toEqual('Settled');

            // A redelivery of the same event finds the recorded payment and does nothing: no Stripe
            // calls are mocked, so any capture attempt would fail the request.
            const errorSpyOnRedelivery = vi.spyOn(Logger, 'error');
            const redeliveryStatus = await postWebhook(
                serverPort,
                amountCapturableUpdatedEvent(order, 'pi_capture_ok'),
            );
            expect(redeliveryStatus).toEqual(200);
            expect(errorSpyOnRedelivery).not.toHaveBeenCalled();
            errorSpyOnRedelivery.mockRestore();
            const afterRedelivery = await adminOrder(order.id);
            expect(afterRedelivery.payments?.filter(p => p.transactionId === 'pi_capture_ok')).toHaveLength(1);
        });

        it('voids the authorization when the item is no longer saleable', async () => {
            await shopClient.asUserWithCredentials(customers[1].emailAddress, 'test');
            const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
                productVariantId: 'T_2',
                quantity: 1,
            });
            orderGuard.assertSuccess(addItemToOrder);
            const order = addItemToOrder;
            await setShipping(shopClient);

            // Make T_2 unsaleable (tracked, zero on hand, no backorder threshold) to simulate the
            // item selling out during checkout.
            await adminClient.query(updateProductVariantsDocument, {
                input: [
                    {
                        id: 'T_2',
                        trackInventory: GlobalFlag.TRUE,
                        stockOnHand: 0,
                        useGlobalOutOfStockThreshold: false,
                        outOfStockThreshold: 0,
                    },
                ],
            });

            mockLiveIntent('pi_void', 'requires_capture');
            const cancelScope = nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_void/cancel')
                .reply(200, { id: 'pi_void', status: 'canceled' });
            // Note: no capture is mocked. If the plugin tried to capture, nock would throw on the
            // unmocked request and fail this test.

            const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_void'));
            expect(status).toEqual(200);
            // The hold was released and nothing was captured or settled.
            expect(cancelScope.isDone()).toBe(true);
            const voided = await adminOrder(order.id);
            expect(voided.state).not.toEqual('PaymentSettled');
            expect(voided.payments?.some(p => p.state === 'Settled')).not.toBe(true);
        });
    });

    describe('webhook resilience', () => {
        it('returns 5xx on an unexpected error so Stripe redelivers the event', async () => {
            // An order that cannot be found is an unexpected/transient condition (for example
            // replication lag), so the handler must not swallow it with a 200. A 5xx lets Stripe
            // retry, and the idempotency guard makes the eventual redelivery safe.
            const status = await postWebhook(
                serverPort,
                amountCapturableUpdatedEvent(
                    { code: 'NON_EXISTENT_ORDER', id: 'T_999999', totalWithTax: 1000 } as any,
                    'pi_unknown_order',
                ),
            );
            expect(status).toBeGreaterThanOrEqual(500);
        });

        it('keeps the payment recoverable when a capture fails with a temporary Stripe error', async () => {
            const order = await prepareOrder(2, 'T_1');

            mockLiveIntent('pi_transient', 'requires_capture');
            mockStripeServerError('post', '/v1/payment_intents/pi_transient/capture');
            const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_transient'));
            // 5xx so Stripe redelivers, and the transaction was rolled back: no payment was recorded,
            // so nothing is stuck in `Error`.
            expect(status).toBeGreaterThanOrEqual(500);
            const afterFailure = await adminOrder(order.id);
            expect(afterFailure.state).not.toEqual('PaymentSettled');
            expect(afterFailure.payments ?? []).toHaveLength(0);

            // The redelivery captures and settles the order.
            mockLiveIntent('pi_transient', 'requires_capture');
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_transient/capture')
                .reply(200, { id: 'pi_transient', status: 'succeeded' });
            const redeliveryStatus = await postWebhook(
                serverPort,
                amountCapturableUpdatedEvent(order, 'pi_transient'),
            );
            expect(redeliveryStatus).toEqual(200);
            const settled = await adminOrder(order.id);
            expect(settled.state).toEqual('PaymentSettled');
        });

        it('settles the order when an earlier capture went through but its response was lost', async () => {
            const order = await prepareOrder(3, 'T_1');

            mockLiveIntent('pi_lost_response', 'requires_capture');
            mockStripeServerError('post', '/v1/payment_intents/pi_lost_response/capture');
            const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_lost_response'));
            expect(status).toBeGreaterThanOrEqual(500);

            // Stripe had in fact captured it. On redelivery the capture is rejected because the intent
            // is already `succeeded`, and the plugin treats that as captured.
            mockLiveIntent('pi_lost_response', 'succeeded');
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_lost_response/capture')
                .reply(400, {
                    error: {
                        type: 'invalid_request_error',
                        code: 'payment_intent_unexpected_state',
                        message: 'This PaymentIntent could not be captured because it has a status of succeeded.',
                    },
                });
            mockLiveIntent('pi_lost_response', 'succeeded');
            const redeliveryStatus = await postWebhook(
                serverPort,
                amountCapturableUpdatedEvent(order, 'pi_lost_response'),
            );
            expect(redeliveryStatus).toEqual(200);
            const settled = await adminOrder(order.id);
            expect(settled.state).toEqual('PaymentSettled');
            expect(settled.payments?.find(p => p.transactionId === 'pi_lost_response')?.state).toEqual('Settled');
        });

        it('records one payment and captures once when the same event is delivered twice at the same time', async () => {
            const order = await prepareOrder(5, 'T_1');

            // Mock enough for both deliveries to capture, and count the captures: the order lock must
            // make the second delivery find the first one's payment instead of capturing again.
            let captures = 0;
            nock(STRIPE_BASE_URL)
                .get('/v1/payment_intents/pi_concurrent')
                .times(2)
                .reply(200, { id: 'pi_concurrent', status: 'requires_capture' });
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_concurrent/capture')
                .times(2)
                .reply(() => {
                    captures++;
                    return [200, { id: 'pi_concurrent', status: 'succeeded' }];
                });

            const event = amountCapturableUpdatedEvent(order, 'pi_concurrent');
            const statuses = await Promise.all([postWebhook(serverPort, event), postWebhook(serverPort, event)]);

            // On databases with row locks the second delivery waits for the first and then finds the
            // payment. On SQLite, which allows one writer at a time, it can instead fail and return
            // 5xx, which is also safe because Stripe would redeliver it.
            expect(statuses.some(s => s === 200)).toBe(true);
            expect(statuses.every(s => s === 200 || s >= 500)).toBe(true);
            expect(captures).toEqual(1);
            const settled = await adminOrder(order.id);
            expect(settled.state).toEqual('PaymentSettled');
            expect(settled.payments?.filter(p => p.transactionId === 'pi_concurrent')).toHaveLength(1);
        });

        it('returns 5xx when a void fails, and acknowledges the redelivery once the intent is cancelled', async () => {
            const order = await prepareOrder(4, 'T_3');
            await makeUnsaleable('T_3');

            mockLiveIntent('pi_void_retry', 'requires_capture');
            mockStripeServerError('post', '/v1/payment_intents/pi_void_retry/cancel');
            const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_void_retry'));
            // The hold may still be in place, so Stripe must redeliver.
            expect(status).toBeGreaterThanOrEqual(500);

            // The void had in fact gone through. The redelivery sees the intent is `canceled` and
            // acknowledges without arranging the order or calling cancel again (no cancel is mocked).
            mockLiveIntent('pi_void_retry', 'canceled');
            const redeliveryStatus = await postWebhook(
                serverPort,
                amountCapturableUpdatedEvent(order, 'pi_void_retry'),
            );
            expect(redeliveryStatus).toEqual(200);
            const afterRedelivery = await adminOrder(order.id);
            expect(afterRedelivery.state).not.toEqual('PaymentSettled');
            expect(afterRedelivery.payments ?? []).toHaveLength(0);
        });
    });
});
