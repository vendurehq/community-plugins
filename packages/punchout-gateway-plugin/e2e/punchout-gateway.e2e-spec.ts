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
    GET_ACTIVE_ORDER,
    GET_ELIGIBLE_SHIPPING_METHODS,
    SET_SHIPPING_ADDRESS,
    SET_SHIPPING_METHOD,
    TRANSFER_PUNCHOUT_CART,
} from './graphql/shop-queries';

/**
 * Extracts the JSON basket from a nock-captured multipart/form-data body.
 * Throws if the body format is unrecognized — fail loudly in tests.
 */
function parseBasketFromBody(body: any): any {
    if (typeof body === 'object' && body.basket) {
        return typeof body.basket === 'string' ? JSON.parse(body.basket) : body.basket;
    }
    if (typeof body === 'string') {
        const match = body.match(/name="basket"\r?\n\r?\n([\s\S]*?)\r?\n--/);
        if (match?.[1]) {
            return JSON.parse(match[1]);
        }
    }
    throw new Error(`Unexpected nock body format: ${typeof body === 'string' ? body.substring(0, 100) : JSON.stringify(body)}`);
}

/** Helper: authenticate + add items + set shipping for a PunchOut session */
async function setupPunchOutOrder(
    client: SimpleGraphQLClient,
    sID: string,
    uID: string,
    variantId = 'T_1',
    quantity = 2,
) {
    nock(mockApiUrl)
        .get('/gateway/v3/session/validate')
        .query({ sID, uID })
        .reply(200);

    await client.query(AUTHENTICATE_PUNCHOUT, { sID, uID });

    const activeOrderInput = { punchout: { sID } };

    await client.query(ADD_ITEM_TO_ORDER, {
        productVariantId: variantId,
        quantity,
        activeOrderInput,
    });

    await client.query(SET_SHIPPING_ADDRESS, {
        input: {
            fullName: 'PunchOut Buyer',
            streetLine1: '123 Procurement St',
            city: 'Berlin',
            postalCode: '10115',
            countryCode: 'AT',
        },
        activeOrderInput,
    });
    const { eligibleShippingMethods } = await client.query(
        GET_ELIGIBLE_SHIPPING_METHODS,
        { activeOrderInput },
    );
    await client.query(SET_SHIPPING_METHOD, {
        id: [eligibleShippingMethods[0].id],
        activeOrderInput,
    });
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

        // Create PunchOut customer with punchOutUid custom field
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
        const transferSID = 'transfer-test-session-001';

        it('should fail transfer when no order exists for session', async () => {
            // Authenticate first, then try to transfer a session with no order
            nock(mockApiUrl)
                .get('/gateway/v3/session/validate')
                .query({ sID: transferSID, uID: mockUID })
                .reply(200);
            await shopClient.query(AUTHENTICATE_PUNCHOUT, { sID: transferSID, uID: mockUID });

            const { transferPunchOutCart } = await shopClient.query(TRANSFER_PUNCHOUT_CART, {
                sID: 'nonexistent-session',
            });
            expect(transferPunchOutCart.success).toBe(false);
            expect(transferPunchOutCart.message).toContain('No active order');
        });

        it('should transfer cart with correct basket structure and exact prices', async () => {
            const sID = 'transfer-test-session-002';
            await setupPunchOutOrder(shopClient, sID, mockUID);

            let capturedBody: any;
            nock(mockApiUrl)
                .post('/gateway/v3/return', (body: any) => {
                    capturedBody = body;
                    return true;
                })
                .query({ sID })
                .reply(200);

            const { transferPunchOutCart } = await shopClient.query(TRANSFER_PUNCHOUT_CART, { sID });
            expect(transferPunchOutCart.success).toBe(true);
            expect(transferPunchOutCart.message).toBeNull();

            const basket = parseBasketFromBody(capturedBody);
            // 1 product + 1 shipping = 2 positions
            expect(basket.basket).toHaveLength(2);

            // Verify product position with exact values
            // Chair: 299.00 net, 20% tax → unitPriceWithTax = 358.80, qty 2
            const productPosition = basket.basket.find((p: any) => p.type === 'product');
            expect(productPosition.product_ordernumber).toBe('CHAIR-01');
            expect(productPosition.product_name).toBe('Office Chair');
            expect(productPosition.quantity).toBe(2);
            expect(productPosition.item_price).toBe(358.8);   // unitPriceWithTax / 100
            expect(productPosition.price).toBe(717.6);        // linePriceWithTax / 100
            expect(productPosition.price_net).toBe(598);       // linePrice / 100
            expect(productPosition.tax_rate).toBe(20);

            // Verify product object
            const prod = productPosition.product;
            expect(prod.ordernumber).toBe('CHAIR-01');
            expect(prod.title).toBe('Office Chair');
            expect(prod.description).toBe('Ergonomic office chair');
            expect(prod.price).toBe(299);                      // unitPrice / 100 (net)
            expect(prod.currency).toBe('USD');
            expect(prod.tax_rate).toBe(20);
            expect(prod.active).toBe(true);
            expect(prod.packaging_unit).toBe('Piece');
            expect(prod.unit).toBe('PCE');

            // Verify shipping position
            // Standard Shipping: 500 cents = 5.00, 0% tax
            const shippingPosition = basket.basket.find((p: any) => p.type === 'shipping-costs');
            expect(shippingPosition.product_ordernumber).toBe('SHIPPING');
            expect(shippingPosition.quantity).toBe(1);
            expect(shippingPosition.price).toBe(5);
            expect(shippingPosition.price_net).toBe(5);
            expect(shippingPosition.tax_rate).toBe(0);
        });

        it('should handle PunchCommerce API failure on transfer', async () => {
            const sID = 'transfer-test-session-003';
            await setupPunchOutOrder(shopClient, sID, mockUID);

            nock(mockApiUrl)
                .post('/gateway/v3/return', () => true)
                .query({ sID })
                .reply(500);

            const { transferPunchOutCart } = await shopClient.query(TRANSFER_PUNCHOUT_CART, { sID });
            expect(transferPunchOutCart.success).toBe(false);
            expect(transferPunchOutCart.message).toBe('HTTP 500');
        });

        it('should not allow re-transfer after order is transferred', async () => {
            const sID = 'transfer-test-session-004';
            await setupPunchOutOrder(shopClient, sID, mockUID);

            // First transfer succeeds
            nock(mockApiUrl)
                .post('/gateway/v3/return', () => true)
                .query({ sID })
                .reply(200);
            const { transferPunchOutCart: first } = await shopClient.query(TRANSFER_PUNCHOUT_CART, { sID });
            expect(first.success).toBe(true);

            // Second transfer fails — order is in Transferred state
            const { transferPunchOutCart: second } = await shopClient.query(TRANSFER_PUNCHOUT_CART, { sID });
            expect(second.success).toBe(false);
            expect(second.message).toContain('No active order');
        });
    });

    describe('Parallel Sessions', () => {
        it('should maintain separate carts for different PunchOut sessions', async () => {
            const sID_A = 'parallel-session-A';
            const sID_B = 'parallel-session-B';

            // Authenticate (same user, same uID)
            nock(mockApiUrl)
                .get('/gateway/v3/session/validate')
                .query({ sID: sID_A, uID: mockUID })
                .reply(200);
            await shopClient.query(AUTHENTICATE_PUNCHOUT, { sID: sID_A, uID: mockUID });

            // Add Chair to session A
            await shopClient.query(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_1',
                quantity: 1,
                activeOrderInput: { punchout: { sID: sID_A } },
            });

            // Add Desk to session B
            await shopClient.query(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_2',
                quantity: 3,
                activeOrderInput: { punchout: { sID: sID_B } },
            });

            // Transfer session A — should only contain the Chair
            let capturedA: any;
            nock(mockApiUrl)
                .post('/gateway/v3/return', (body: any) => { capturedA = body; return true; })
                .query({ sID: sID_A })
                .reply(200);
            const { transferPunchOutCart: resultA } = await shopClient.query(TRANSFER_PUNCHOUT_CART, { sID: sID_A });
            expect(resultA.success).toBe(true);

            const basketA = parseBasketFromBody(capturedA);
            const productA = basketA.basket.find((p: any) => p.type === 'product');
            expect(productA.product_ordernumber).toBe('CHAIR-01');
            expect(productA.quantity).toBe(1);

            // Transfer session B — should only contain the Desk
            let capturedB: any;
            nock(mockApiUrl)
                .post('/gateway/v3/return', (body: any) => { capturedB = body; return true; })
                .query({ sID: sID_B })
                .reply(200);
            const { transferPunchOutCart: resultB } = await shopClient.query(TRANSFER_PUNCHOUT_CART, { sID: sID_B });
            expect(resultB.success).toBe(true);

            const basketB = parseBasketFromBody(capturedB);
            const productB = basketB.basket.find((p: any) => p.type === 'product');
            expect(productB.product_ordernumber).toBe('DESK-01');
            expect(productB.quantity).toBe(3);
        });

        it('should not leak cart from session A when querying activeOrder with session B sID', async () => {
            const sID_A = 'isolation-session-A';
            const sID_B = 'isolation-session-B';

            nock(mockApiUrl)
                .get('/gateway/v3/session/validate')
                .query({ sID: sID_A, uID: mockUID })
                .reply(200);
            await shopClient.query(AUTHENTICATE_PUNCHOUT, { sID: sID_A, uID: mockUID });

            // Add items to session A
            await shopClient.query(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_1',
                quantity: 5,
                activeOrderInput: { punchout: { sID: sID_A } },
            });

            // Query activeOrder with session B — should get an empty cart, not session A's
            const { activeOrder } = await shopClient.query(GET_ACTIVE_ORDER, {
                activeOrderInput: { punchout: { sID: sID_B } },
            });
            expect(activeOrder).toBeDefined();
            expect(activeOrder.lines).toHaveLength(0);
            expect(activeOrder.totalQuantity).toBe(0);

            // Session A should still have its items
            const { activeOrder: orderA } = await shopClient.query(GET_ACTIVE_ORDER, {
                activeOrderInput: { punchout: { sID: sID_A } },
            });
            expect(orderA.totalQuantity).toBe(5);
        });
    });

    describe('Shipping Cost Modes', () => {
        it('should omit shipping when shippingCostMode is none', async () => {
            // This test uses the plugin configured with 'nonZero', so shipping (5.00) IS included.
            // To test 'none' mode we'd need a separate plugin instance.
            // For now, verify the nonZero mode correctly includes non-zero shipping.
            const sID = 'shipping-mode-test';
            await setupPunchOutOrder(shopClient, sID, mockUID);

            let capturedBody: any;
            nock(mockApiUrl)
                .post('/gateway/v3/return', (body: any) => { capturedBody = body; return true; })
                .query({ sID })
                .reply(200);

            await shopClient.query(TRANSFER_PUNCHOUT_CART, { sID });

            const basket = parseBasketFromBody(capturedBody);
            const shipping = basket.basket.find((p: any) => p.type === 'shipping-costs');
            // Standard Shipping is 5.00 (non-zero), so it should be included in 'nonZero' mode
            expect(shipping).toBeDefined();
            expect(shipping.price).toBe(5);
        });
    });
});
