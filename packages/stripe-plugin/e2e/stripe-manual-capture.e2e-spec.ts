/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { CurrencyCode, GlobalFlag, LanguageCode } from '@vendure/common/lib/generated-types';
import { Logger, mergeConfig, OrderService } from '@vendure/core';
import {
    createErrorResultGuard,
    createTestEnvironment,
    E2E_DEFAULT_CHANNEL_TOKEN,
    ErrorResultGuard,
} from '@vendure/testing';
import nock from 'nock';
import fetch from 'node-fetch';
import path from 'path';
import Stripe from 'stripe';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { StripePlugin } from '../src';
import { StripePaymentIntent } from '../src/stripe-types';
import { stripePaymentMethodHandler } from '../src/stripe.handler';

import {
    createPaymentMethodDocument,
    getCustomerListDocument,
    getOrderPaymentsDocument,
    settlePaymentDocument,
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
    const header = new Stripe('test-api-key').webhooks.generateTestHeaderString({
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
function mockLiveIntent(id: string, status: StripePaymentIntent['status']) {
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

/**
 * Stripe refuses to capture an intent that is captured already, and the plugin then reads its live
 * state.
 */
function mockAlreadyCaptured(id: string) {
    nock(STRIPE_BASE_URL)
        .post(`/v1/payment_intents/${id}/capture`)
        .reply(400, {
            error: {
                type: 'invalid_request_error',
                code: 'payment_intent_unexpected_state',
                message: 'This PaymentIntent could not be captured because it has a status of succeeded.',
            },
        });
    mockLiveIntent(id, 'succeeded');
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

function succeededEvent(order: FragmentOf<typeof testOrderFragment>, paymentIntentId: string) {
    const event = amountCapturableUpdatedEvent(order, paymentIntentId);
    return {
        ...event,
        id: `evt_succeeded_${paymentIntentId}`,
        type: 'payment_intent.succeeded',
        data: {
            object: {
                ...event.data.object,
                amount_capturable: 0,
                amount_received: order.totalWithTax,
                status: 'succeeded',
            },
        },
    };
}

function canceledEvent(order: FragmentOf<typeof testOrderFragment>, paymentIntentId: string) {
    const event = amountCapturableUpdatedEvent(order, paymentIntentId);
    return {
        ...event,
        id: `evt_canceled_${paymentIntentId}`,
        type: 'payment_intent.canceled',
        data: {
            object: {
                ...event.data.object,
                amount_capturable: 0,
                status: 'canceled',
                cancellation_reason: 'automatic',
            },
        },
    };
}

/** Resolves once `predicate` is true, so a test can act while a request is still in flight. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('Timed out waiting for condition');
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
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

        it('voids an authorization that no longer covers the order, without recording or capturing it', async () => {
            // The intent was created for this total...
            const staleOrder = await prepareOrder(0, 'T_1');
            // ...then the cart changed, and the customer confirmed the old client secret.
            const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
                productVariantId: 'T_1',
                quantity: 1,
            });
            orderGuard.assertSuccess(addItemToOrder);
            const { activeOrder } = await shopClient.query(getActiveOrderDocument);
            expect(activeOrder!.totalWithTax).toBeGreaterThan(staleOrder.totalWithTax);

            mockLiveIntent('pi_stale', 'requires_capture');
            const cancelScope = nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_stale/cancel')
                .reply(200, { id: 'pi_stale', status: 'canceled' });
            // No capture is mocked, so a capture attempt would fail the request.

            const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(staleOrder, 'pi_stale'));
            expect(status).toEqual(200);
            expect(cancelScope.isDone()).toBe(true);
            // The payment was rolled back with the hold, so the order is not left with a payment for
            // an intent that no longer exists, and it never reached PaymentAuthorized.
            const afterVoid = await adminOrder(staleOrder.id);
            expect(afterVoid.state).not.toEqual('PaymentAuthorized');
            expect(afterVoid.payments ?? []).toHaveLength(0);
        });
    });

    describe('capture outside the transaction', () => {
        let orderService: OrderService;

        beforeAll(() => {
            orderService = server.app.get(OrderService);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('persists the Authorized payment before Stripe is called to capture it', async () => {
            const order = await prepareOrder(0, 'T_1');

            mockLiveIntent('pi_after_commit', 'requires_capture');
            let seenDuringCapture: Awaited<ReturnType<typeof adminOrder>> | undefined;
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_after_commit/capture')
                .reply(function (_uri, _body, cb) {
                    // Read through the Admin API, i.e. on another connection: this only sees the
                    // payment if the transaction that recorded it has already been committed.
                    adminOrder(order.id)
                        .then(o => {
                            seenDuringCapture = o;
                            cb(null, [200, { id: 'pi_after_commit', status: 'succeeded' }]);
                        })
                        .catch(err => cb(err as Error, [500, '']));
                });

            const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_after_commit'));
            expect(status).toEqual(200);
            expect(seenDuringCapture?.state).toEqual('PaymentAuthorized');
            expect(seenDuringCapture?.payments?.map(p => p.state)).toEqual(['Authorized']);
            const settled = await adminOrder(order.id);
            expect(settled.state).toEqual('PaymentSettled');
            expect(settled.payments?.map(p => p.state)).toEqual(['Settled']);
        });

        it('does not capture when the transaction recording the payment fails', async () => {
            const order = await prepareOrder(2, 'T_1');

            mockLiveIntent('pi_rollback', 'requires_capture');
            // No capture is mocked: reaching Stripe before the commit would fail the request on the
            // unmocked call, and the payment is rolled back so there is nothing to capture.
            const captureScope = nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_rollback/capture')
                .reply(200, { id: 'pi_rollback', status: 'succeeded' });
            vi.spyOn(orderService, 'addPaymentToOrder').mockRejectedValueOnce(new Error('simulated failure'));

            const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_rollback'));
            expect(status).toBeGreaterThanOrEqual(500);
            expect(captureScope.isDone()).toBe(false);
            const afterFailure = await adminOrder(order.id);
            expect(afterFailure.payments ?? []).toHaveLength(0);

            // The redelivery goes through normally.
            mockLiveIntent('pi_rollback', 'requires_capture');
            const redeliveryStatus = await postWebhook(
                serverPort,
                amountCapturableUpdatedEvent(order, 'pi_rollback'),
            );
            expect(redeliveryStatus).toEqual(200);
            expect(captureScope.isDone()).toBe(true);
            expect((await adminOrder(order.id)).state).toEqual('PaymentSettled');
        });

        describe('a crash after the funds were captured', () => {
            it('is reconciled by the payment_intent.succeeded webhook, without calling Stripe', async () => {
                const order = await prepareOrder(3, 'T_1');

                mockLiveIntent('pi_crash', 'requires_capture');
                nock(STRIPE_BASE_URL)
                    .post('/v1/payment_intents/pi_crash/capture')
                    .reply(200, { id: 'pi_crash', status: 'succeeded' });
                // The funds were captured, then the settlement fails (as it would if the process died).
                vi.spyOn(orderService, 'settlePayment').mockRejectedValueOnce(new Error('simulated crash'));

                const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_crash'));
                expect(status).toBeGreaterThanOrEqual(500);
                const afterCrash = await adminOrder(order.id);
                expect(afterCrash.state).toEqual('PaymentAuthorized');
                expect(afterCrash.payments?.map(p => p.state)).toEqual(['Authorized']);

                // Settling is database-only: nothing is mocked, so any Stripe call fails the request.
                const succeededStatus = await postWebhook(serverPort, succeededEvent(order, 'pi_crash'));
                expect(succeededStatus).toEqual(200);
                const settled = await adminOrder(order.id);
                expect(settled.state).toEqual('PaymentSettled');
                expect(settled.payments?.map(p => p.state)).toEqual(['Settled']);
            });

            it('is also reconciled by a redelivery of the authorization event', async () => {
                const order = await prepareOrder(5, 'T_1');

                mockLiveIntent('pi_crash_redelivery', 'requires_capture');
                nock(STRIPE_BASE_URL)
                    .post('/v1/payment_intents/pi_crash_redelivery/capture')
                    .reply(200, { id: 'pi_crash_redelivery', status: 'succeeded' });
                vi.spyOn(orderService, 'settlePayment').mockRejectedValueOnce(new Error('simulated crash'));
                const status = await postWebhook(
                    serverPort,
                    amountCapturableUpdatedEvent(order, 'pi_crash_redelivery'),
                );
                expect(status).toBeGreaterThanOrEqual(500);

                // The funds are captured already, so Stripe refuses the repeated capture and the plugin
                // settles from the intent's live state.
                mockAlreadyCaptured('pi_crash_redelivery');
                const redeliveryStatus = await postWebhook(
                    serverPort,
                    amountCapturableUpdatedEvent(order, 'pi_crash_redelivery'),
                );
                expect(redeliveryStatus).toEqual(200);
                const settled = await adminOrder(order.id);
                expect(settled.state).toEqual('PaymentSettled');
                expect(settled.payments?.map(p => p.state)).toEqual(['Settled']);
            });
        });

        describe('payment_intent.succeeded', () => {
            async function authorizeWithoutSettling(orderIndex: number, intentId: string) {
                const order = await prepareOrder(orderIndex, 'T_1');
                mockLiveIntent(intentId, 'requires_capture');
                nock(STRIPE_BASE_URL)
                    .post(`/v1/payment_intents/${intentId}/capture`)
                    .reply(200, { id: intentId, status: 'succeeded' });
                vi.spyOn(orderService, 'settlePayment').mockRejectedValueOnce(new Error('simulated crash'));
                const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, intentId));
                expect(status).toBeGreaterThanOrEqual(500);
                return order;
            }

            it('settles the payment exactly once when delivered several times, also at the same time', async () => {
                const order = await authorizeWithoutSettling(0, 'pi_duplicates');
                const settleSpy = vi.spyOn(orderService, 'settlePayment');

                const event = succeededEvent(order, 'pi_duplicates');
                const statuses = await Promise.all([
                    postWebhook(serverPort, event),
                    postWebhook(serverPort, event),
                    postWebhook(serverPort, event),
                ]);
                // On SQLite, which allows one writer at a time, a concurrent delivery can fail with a
                // 5xx instead of waiting for the lock. That is safe too, since Stripe redelivers it.
                expect(statuses.some(s => s === 200)).toBe(true);
                expect(statuses.every(s => s === 200 || s >= 500)).toBe(true);
                // A sequential redelivery finds the settled payment and does nothing.
                expect(await postWebhook(serverPort, event)).toEqual(200);

                expect(settleSpy).toHaveBeenCalledTimes(1);
                const settled = await adminOrder(order.id);
                expect(settled.state).toEqual('PaymentSettled');
                expect(settled.payments?.map(p => p.state)).toEqual(['Settled']);
            });

            it('settles once when it races the capture that is still in flight', async () => {
                const order = await prepareOrder(2, 'T_1');

                mockLiveIntent('pi_race', 'requires_capture');
                let captureStarted = false;
                let finishCapture: () => void = () => undefined;
                nock(STRIPE_BASE_URL)
                    .post('/v1/payment_intents/pi_race/capture')
                    .reply((_uri, _body, cb) => {
                        captureStarted = true;
                        // Hold the response back until the `succeeded` event has been processed.
                        finishCapture = () => cb(null, [200, { id: 'pi_race', status: 'succeeded' }]);
                    });
                const settleSpy = vi.spyOn(orderService, 'settlePayment');

                const authorization = postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_race'));
                await waitFor(() => captureStarted);
                // Stripe has captured and sends `succeeded` before the capture call has returned. The
                // payment was committed as `Authorized` already, so this settles it.
                expect(await postWebhook(serverPort, succeededEvent(order, 'pi_race'))).toEqual(200);
                expect((await adminOrder(order.id)).state).toEqual('PaymentSettled');

                finishCapture();
                // The capture step then finds the payment settled and leaves it alone.
                expect(await authorization).toEqual(200);
                expect(settleSpy).toHaveBeenCalledTimes(1);
                const settled = await adminOrder(order.id);
                expect(settled.payments?.map(p => p.state)).toEqual(['Settled']);
            });

            it('does nothing when no payment has been recorded yet, and the authorization event settles later', async () => {
                const order = await prepareOrder(3, 'T_1');

                const settleSpy = vi.spyOn(orderService, 'settlePayment');
                expect(await postWebhook(serverPort, succeededEvent(order, 'pi_early'))).toEqual(200);
                expect(settleSpy).not.toHaveBeenCalled();
                expect((await adminOrder(order.id)).payments ?? []).toHaveLength(0);

                // The authorization event arrives afterwards. The intent is already captured, so the
                // capture is refused as such and the payment is settled from the live state.
                mockLiveIntent('pi_early', 'succeeded');
                nock(STRIPE_BASE_URL)
                    .post('/v1/payment_intents/pi_early/capture')
                    .reply(400, {
                        error: {
                            type: 'invalid_request_error',
                            code: 'payment_intent_unexpected_state',
                            message: 'This PaymentIntent could not be captured because it has a status of succeeded.',
                        },
                    });
                mockLiveIntent('pi_early', 'succeeded');
                expect(await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_early'))).toEqual(200);
                const settled = await adminOrder(order.id);
                expect(settled.state).toEqual('PaymentSettled');
                expect(settled.payments?.map(p => p.state)).toEqual(['Settled']);
            });
        });

        it('keeps the payment Authorized when Stripe refuses the capture, so it can be settled from the Admin API', async () => {
            const order = await prepareOrder(5, 'T_1');

            mockLiveIntent('pi_refused', 'requires_capture');
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_refused/capture')
                .reply(400, {
                    error: {
                        type: 'invalid_request_error',
                        code: 'amount_too_large',
                        message: 'Amount must be no more than the amount authorized.',
                    },
                });
            // Redelivering would not change the outcome, so the event is acknowledged.
            expect(await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_refused'))).toEqual(200);
            const afterRefusal = await adminOrder(order.id);
            expect(afterRefusal.state).toEqual('PaymentAuthorized');
            expect(afterRefusal.payments?.map(p => p.state)).toEqual(['Authorized']);

            // Settling from the Admin API still captures through the payment handler.
            const captureScope = nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_refused/capture')
                .reply(200, { id: 'pi_refused', status: 'succeeded' });
            const { settlePayment } = await adminClient.query(settlePaymentDocument, {
                id: afterRefusal.payments![0].id,
            });
            expect(settlePayment).toMatchObject({ state: 'Settled' });
            expect(captureScope.isDone()).toBe(true);
        });
    });

    describe('payment_intent.canceled', () => {
        it('cancels a payment whose authorization expired before it was captured, without calling Stripe', async () => {
            const order = await prepareOrder(0, 'T_1');

            // Leave the payment `Authorized`: the capture is refused, so the funds stay held.
            mockLiveIntent('pi_expired', 'requires_capture');
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_expired/capture')
                .reply(400, {
                    error: {
                        type: 'invalid_request_error',
                        code: 'amount_too_large',
                        message: 'Amount must be no more than the amount authorized.',
                    },
                });
            expect(await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_expired'))).toEqual(200);
            expect((await adminOrder(order.id)).payments?.map(p => p.state)).toEqual(['Authorized']);

            // Stripe cancels the uncaptured authorization. Nothing is mocked, so any Stripe call (for
            // example the payment handler trying to void it again) fails the request.
            const event = canceledEvent(order, 'pi_expired');
            expect(await postWebhook(serverPort, event)).toEqual(200);
            const afterExpiry = await adminOrder(order.id);
            expect(afterExpiry.payments?.map(p => p.state)).toEqual(['Cancelled']);

            // A redelivery finds the payment cancelled already and does nothing.
            expect(await postWebhook(serverPort, event)).toEqual(200);
            expect((await adminOrder(order.id)).payments?.map(p => p.state)).toEqual(['Cancelled']);
        });

        it('acknowledges the event for an intent the plugin voided itself, which has no payment', async () => {
            const order = await prepareOrder(2, 'T_1');
            expect(await postWebhook(serverPort, canceledEvent(order, 'pi_voided_by_plugin'))).toEqual(200);
            expect((await adminOrder(order.id)).payments ?? []).toHaveLength(0);
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
            const failedKeys: string[] = [];
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_transient/capture')
                .times(3)
                .reply(function () {
                    failedKeys.push(this.req.headers['idempotency-key']);
                    return [500, { error: { type: 'api_error', message: 'Stripe is having a bad day' } }];
                });
            const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_transient'));
            // 5xx so Stripe redelivers. The authorization was committed before Stripe was called, so
            // the payment is still `Authorized` and recoverable rather than stuck in `Error`.
            expect(status).toBeGreaterThanOrEqual(500);
            const afterFailure = await adminOrder(order.id);
            expect(afterFailure.state).toEqual('PaymentAuthorized');
            expect(afterFailure.payments?.map(p => p.state)).toEqual(['Authorized']);

            // The redelivery finds the authorized payment, captures and settles the order. Stripe
            // returns the stored response for a reused idempotency key for 24 hours, 500s included,
            // so the retry only reaches Stripe if it carries a new key.
            let retryKey: string | undefined;
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_transient/capture')
                .reply(function () {
                    retryKey = this.req.headers['idempotency-key'];
                    return [200, { id: 'pi_transient', status: 'succeeded' }];
                });
            const redeliveryStatus = await postWebhook(
                serverPort,
                amountCapturableUpdatedEvent(order, 'pi_transient'),
            );
            expect(redeliveryStatus).toEqual(200);
            expect(failedKeys).toHaveLength(3);
            expect(failedKeys).not.toContain(retryKey);
            expect(failedKeys.some(key => key?.includes('pi_transient'))).toBe(false);
            const settled = await adminOrder(order.id);
            expect(settled.state).toEqual('PaymentSettled');
            expect(settled.payments?.map(p => p.state)).toEqual(['Settled']);
        });

        it('settles the order when an earlier capture went through but its response was lost', async () => {
            const order = await prepareOrder(3, 'T_1');

            mockLiveIntent('pi_lost_response', 'requires_capture');
            mockStripeServerError('post', '/v1/payment_intents/pi_lost_response/capture');
            const status = await postWebhook(serverPort, amountCapturableUpdatedEvent(order, 'pi_lost_response'));
            expect(status).toBeGreaterThanOrEqual(500);

            // Stripe had in fact captured it. On redelivery the capture is rejected because the intent
            // is already `succeeded`, and the plugin treats that as captured.
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

        it('records one payment and settles it once when the same event is delivered twice at the same time', async () => {
            const order = await prepareOrder(5, 'T_1');

            // The order lock makes the second delivery wait until the first has recorded the payment,
            // so it finds an `Authorized` payment and resumes the capture. Stripe refuses that second
            // capture because the funds are captured already, and only one payment is recorded and
            // settled.
            nock(STRIPE_BASE_URL)
                .get('/v1/payment_intents/pi_concurrent')
                .times(2)
                .reply(200, { id: 'pi_concurrent', status: 'requires_capture' });
            nock(STRIPE_BASE_URL)
                .post('/v1/payment_intents/pi_concurrent/capture')
                .reply(200, { id: 'pi_concurrent', status: 'succeeded' });
            mockAlreadyCaptured('pi_concurrent');

            const event = amountCapturableUpdatedEvent(order, 'pi_concurrent');
            const statuses = await Promise.all([postWebhook(serverPort, event), postWebhook(serverPort, event)]);

            // On databases with row locks the second delivery waits for the first and then finds the
            // payment. On SQLite, which allows one writer at a time, it can instead fail and return
            // 5xx, which is also safe because Stripe would redeliver it.
            expect(statuses.some(s => s === 200)).toBe(true);
            expect(statuses.every(s => s === 200 || s >= 500)).toBe(true);
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
