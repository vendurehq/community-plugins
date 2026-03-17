import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, SimpleGraphQLClient, TestServer } from '@vendure/testing';
import gql from 'graphql-tag';
import nock from 'nock';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { PunchOutGatewayPlugin } from '../src/punchout-gateway-plugin';

import {
    mockApiUrl,
    mockSID,
    mockUID,
} from './fixtures/punchcommerce-mock-data';
import {
    ADD_ITEM_TO_ORDER,
    AUTHENTICATE_PUNCHOUT,
    GET_ELIGIBLE_SHIPPING_METHODS,
    SET_SHIPPING_ADDRESS,
    SET_SHIPPING_METHOD,
    TRANSFER_PUNCHOUT_CART,
} from './graphql/shop-queries';

/**
 * Extracts the JSON basket from a nock-captured body.
 * Nock may pass URL-encoded body as a parsed object or string.
 */
function parseBasketFromBody(body: any): any {
    if (typeof body === 'object' && body.basket) {
        // nock parsed the URL-encoded body into { basket: "..." }
        return typeof body.basket === 'string' ? JSON.parse(body.basket) : body.basket;
    }
    if (typeof body === 'string') {
        const params = new URLSearchParams(body);
        const basketStr = params.get('basket');
        return basketStr ? JSON.parse(basketStr) : undefined;
    }
    return undefined;
}

describe('PunchOut Gateway Plugin', () => {
    let shopClient: SimpleGraphQLClient;
    let adminClient: SimpleGraphQLClient;
    let server: TestServer;
    let started = false;

    beforeAll(async () => {
        const devConfig = mergeConfig(testConfig(), {
            plugins: [
                PunchOutGatewayPlugin.init({
                    apiUrl: mockApiUrl,
                    shippingCostMode: 'nonZero',
                }),
            ],
        });
        const env = createTestEnvironment(devConfig);
        shopClient = env.shopClient;
        adminClient = env.adminClient;
        server = env.server;
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
            customerCount: 2,
        });
        started = true;
        await adminClient.asSuperAdmin();

        await adminClient.query(gql`
            mutation CreateCustomer($input: CreateCustomerInput!, $password: String) {
                createCustomer(input: $input, password: $password) {
                    ... on Customer { id }
                    ... on ErrorResult { errorCode message }
                }
            }
        `, {
            input: {
                firstName: 'PunchOut',
                lastName: 'Buyer',
                emailAddress: 'punchout-buyer@test.com',
                customFields: { punchOutUid: mockUID },
            },
            password: 'test',
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    afterEach(() => {
        nock.cleanAll();
    });

    it('should start successfully', () => {
        expect(started).toBe(true);
    });

    describe('Authentication', () => {
        it('should authenticate with valid PunchOut session', async () => {
            nock(mockApiUrl)
                .get('/gateway/v3/session/validate')
                .query({ sID: mockSID, uID: mockUID })
                .reply(200);

            const { authenticate } = await shopClient.query(AUTHENTICATE_PUNCHOUT, {
                sID: mockSID,
                uID: mockUID,
            });
            expect(authenticate.__typename).toBe('CurrentUser');
            expect(authenticate.id).toBeDefined();
            expect(authenticate.identifier).toBe('punchout-buyer@test.com');
        });

        it('should fail authentication with invalid session', async () => {
            nock(mockApiUrl)
                .get('/gateway/v3/session/validate')
                .query({ sID: 'invalid-session', uID: mockUID })
                .reply(400);

            const { authenticate } = await shopClient.query(AUTHENTICATE_PUNCHOUT, {
                sID: 'invalid-session',
                uID: mockUID,
            });
            expect(authenticate.errorCode).toBe('INVALID_CREDENTIALS_ERROR');
        });

        it('should fail authentication when customer not found', async () => {
            nock(mockApiUrl)
                .get('/gateway/v3/session/validate')
                .query({ sID: mockSID, uID: 'unknown-user' })
                .reply(200);

            const { authenticate } = await shopClient.query(AUTHENTICATE_PUNCHOUT, {
                sID: mockSID,
                uID: 'unknown-user',
            });
            expect(authenticate.errorCode).toBe('INVALID_CREDENTIALS_ERROR');
        });

        it('should fail authentication when PunchCommerce API is unreachable', async () => {
            nock(mockApiUrl)
                .get('/gateway/v3/session/validate')
                .query({ sID: mockSID, uID: mockUID })
                .replyWithError('Connection refused');

            const { authenticate } = await shopClient.query(AUTHENTICATE_PUNCHOUT, {
                sID: mockSID,
                uID: mockUID,
            });
            expect(authenticate.errorCode).toBe('INVALID_CREDENTIALS_ERROR');
        });
    });

    describe('Cart Transfer', () => {
        it('should fail transfer when not authenticated', async () => {
            const { transferPunchOutCart } = await shopClient.query(TRANSFER_PUNCHOUT_CART, {
                sID: mockSID,
            });
            expect(transferPunchOutCart.success).toBe(false);
        });

        it('should transfer cart after authentication and adding items', async () => {
            nock(mockApiUrl)
                .get('/gateway/v3/session/validate')
                .query({ sID: mockSID, uID: mockUID })
                .reply(200);

            await shopClient.query(AUTHENTICATE_PUNCHOUT, {
                sID: mockSID,
                uID: mockUID,
            });

            const activeOrderInput = { punchout: { sID: mockSID } };

            const { addItemToOrder } = await shopClient.query(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_1',
                quantity: 2,
                activeOrderInput,
            });
            expect(addItemToOrder.lines).toHaveLength(1);
            expect(addItemToOrder.lines[0].quantity).toBe(2);

            await shopClient.query(SET_SHIPPING_ADDRESS, {
                input: {
                    fullName: 'PunchOut Buyer',
                    streetLine1: '123 Procurement St',
                    city: 'Berlin',
                    postalCode: '10115',
                    countryCode: 'AT',
                },
                activeOrderInput,
            });
            const { eligibleShippingMethods } = await shopClient.query(
                GET_ELIGIBLE_SHIPPING_METHODS,
                { activeOrderInput },
            );
            await shopClient.query(SET_SHIPPING_METHOD, {
                id: [eligibleShippingMethods[0].id],
                activeOrderInput,
            });

            let capturedBody: any;
            nock(mockApiUrl)
                .post('/gateway/v3/return', (body: any) => {
                    capturedBody = body;
                    return true;
                })
                .query({ sID: mockSID })
                .reply(200);

            const { transferPunchOutCart } = await shopClient.query(TRANSFER_PUNCHOUT_CART, {
                sID: mockSID,
            });
            expect(transferPunchOutCart.success).toBe(true);

            const basket = parseBasketFromBody(capturedBody);
            expect(basket).toBeDefined();
            expect(basket.basket).toBeDefined();
            expect(basket.basket.length).toBeGreaterThanOrEqual(1);

            const productPosition = basket.basket.find(
                (p: any) => p.type === 'product',
            );
            expect(productPosition).toBeDefined();
            expect(productPosition.product_ordernumber).toBe('CHAIR-01');
            expect(productPosition.quantity).toBe(2);
            expect(productPosition.item_price).toBeGreaterThan(0);
            expect(productPosition.price).toBeGreaterThan(0);
            expect(productPosition.price_net).toBeGreaterThan(0);

            const prod = productPosition.product;
            expect(prod.id).toBeDefined();
            expect(prod.ordernumber).toBe('CHAIR-01');
            expect(prod.title).toBeDefined();
            expect(prod.price).toBeGreaterThan(0);
            expect(prod.active).toBe(true);
            expect(prod.packaging_unit).toBeTruthy();

            // Verify shipping line item is included
            const shippingPosition = basket.basket.find(
                (p: any) => p.type === 'shipping-costs',
            );
            expect(shippingPosition).toBeDefined();
            expect(shippingPosition.product_ordernumber).toBe('SHIPPING');
            expect(shippingPosition.quantity).toBe(1);
            expect(shippingPosition.price).toBeGreaterThan(0);

            // Verify all prices are decimal (not integer cents)
            for (const position of basket.basket) {
                expect(position.item_price).toBeLessThan(10000);
                expect(position.price).toBeLessThan(100000);
                expect(position.price_net).toBeLessThan(100000);
                expect(position.product.price).toBeLessThan(10000);
            }
        });

        it('should not allow re-transfer after order is transferred', async () => {
            // The order from the previous test should now be in Transferred state
            const { transferPunchOutCart } = await shopClient.query(TRANSFER_PUNCHOUT_CART, {
                sID: mockSID,
            });
            expect(transferPunchOutCart.success).toBe(false);
        });
    });
});
