/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { OrderStatus } from '@mollie/api-client';
import {
    ChannelService,
    ConfigService,
    DefaultMoneyStrategy,
    LanguageCode,
    mergeConfig,
    OrderService,
    RequestContext,
} from '@vendure/core';
import {
    createTestEnvironment,
    E2E_DEFAULT_CHANNEL_TOKEN,
    SimpleGraphQLClient,
    TestServer,
} from '@vendure/testing';
import nock from 'nock';
import fetch from 'node-fetch';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { MolliePlugin } from '../src';
import { molliePaymentHandler } from '../src/mollie.handler';
import { amountToCents, getMoneyPrecision, toAmount } from '../src/mollie.helpers';

import { mollieMockData } from './fixtures/mollie-mock-data';
import {
    createPaymentMethodDocument,
    getCustomerListDocument,
    getOrderPaymentsDocument,
    updateProductVariantsDocument,
} from './graphql/admin-definitions';
import { testOrderFragment } from './graphql/fragments-shop';
import { FragmentOf, ResultOf } from './graphql/graphql-admin';
import { createMolliePaymentIntentDocument } from './graphql/shared-definitions';
import {
    addItemToOrderDocument,
    getEligibleShippingMethodsDocument,
    setShippingMethodDocument,
} from './graphql/shop-definitions';
import { addManualPayment, refundOrderLine, setShipping } from './payment-helpers';

// https://github.com/vendurehq/community-plugins/issues/37
describe('Converting between Vendure money and Mollie amounts', () => {
    it('Should convert with 2 decimals when no precision is given', () => {
        expect(toAmount(12895, 'EUR')).toEqual({ value: '128.95', currency: 'EUR' });
        expect(toAmount(12895, 'EUR', 2)).toEqual({ value: '128.95', currency: 'EUR' });
        expect(amountToCents({ value: '128.95', currency: 'EUR' })).toBe(12895);
        expect(amountToCents({ value: '128.95', currency: 'EUR' }, 2)).toBe(12895);
    });

    it.each([
        { value: 128950, precision: 3, expected: '128.95' },
        { value: 128954, precision: 3, expected: '128.95' },
        { value: 128956, precision: 3, expected: '128.96' },
        { value: -128956, precision: 3, expected: '-128.96' },
        { value: 0, precision: 3, expected: '0.00' },
        { value: 12890, precision: 1, expected: '1289.00' },
        { value: 500, precision: 0, expected: '500.00' },
    ])('Should send $value with precision $precision as $expected', ({ value, precision, expected }) => {
        expect(toAmount(value, 'EUR', precision)).toEqual({ value: expected, currency: 'EUR' });
    });

    it.each([
        { value: '128.95', precision: 3, expected: 128950 },
        { value: '-128.95', precision: 3, expected: -128950 },
        { value: '0.00', precision: 3, expected: 0 },
        { value: '128.90', precision: 1, expected: 1289 },
        { value: '500.00', precision: 0, expected: 500 },
        // Not whole units of the store's precision: rounded to the nearest unit
        { value: '128.94', precision: 1, expected: 1289 },
        { value: '128.94', precision: 0, expected: 129 },
        // Large amounts keep every digit
        { value: '45035996273694.96', precision: 2, expected: 4503599627369496 },
        { value: '6000000000000.03', precision: 3, expected: 6000000000000030 },
    ])(
        'Should record the Mollie amount $value with precision $precision as $expected',
        ({ value, precision, expected }) => {
            expect(amountToCents({ value, currency: 'EUR' }, precision)).toBe(expected);
        },
    );

    it('Should read the precision from the MoneyStrategy, where 0 is a valid precision', () => {
        const configWith = (precision?: number) =>
            ({ entityOptions: { moneyStrategy: { precision } } }) as unknown as ConfigService;
        expect(getMoneyPrecision(configWith(3))).toBe(3);
        expect(getMoneyPrecision(configWith(0))).toBe(0);
        expect(getMoneyPrecision(configWith(undefined))).toBe(2);
    });
});

class ThreeDecimalMoneyStrategy extends DefaultMoneyStrategy {
    readonly precision = 3;
}

describe('Mollie payments with a MoneyStrategy of 3 decimals', () => {
    let shopClient: SimpleGraphQLClient;
    let adminClient: SimpleGraphQLClient;
    let server: TestServer;
    let serverPort: number;
    let customers: ResultOf<typeof getCustomerListDocument>['customers']['items'];
    let order: FragmentOf<typeof testOrderFragment>;
    // Prices have 3 decimals: 12000 is 12.000
    const SURCHARGE_AMOUNT = -5000;

    beforeAll(async () => {
        const devConfig = mergeConfig(testConfig(), {
            plugins: [MolliePlugin.init({ vendureHost: mollieMockData.host })],
            entityOptions: { moneyStrategy: new ThreeDecimalMoneyStrategy() },
        });
        const env = createTestEnvironment(devConfig);
        serverPort = devConfig.apiOptions.port;
        shopClient = env.shopClient;
        adminClient = env.adminClient;
        server = env.server;
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
            customerCount: 2,
        });
        await adminClient.asSuperAdmin();
        ({
            customers: { items: customers },
        } = await adminClient.query(getCustomerListDocument, { options: { take: 2 } }));
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    afterEach(() => {
        nock.cleanAll();
    });

    it('Should use the 3 decimals of the store', () => {
        expect(server.app.get(ConfigService).entityOptions.moneyStrategy.precision).toBe(3);
    });

    it('Should create a Mollie paymentMethod', async () => {
        const { createPaymentMethod } = await adminClient.query(createPaymentMethodDocument, {
            input: {
                code: mollieMockData.methodCode,
                enabled: true,
                handler: {
                    code: molliePaymentHandler.code,
                    arguments: [
                        { name: 'redirectUrl', value: mollieMockData.redirectUrl },
                        { name: 'apiKey', value: mollieMockData.apiKey },
                    ],
                },
                translations: [
                    {
                        languageCode: LanguageCode.en,
                        name: 'Mollie payment test',
                        description: 'This is a Mollie test payment method',
                    },
                ],
            },
        });
        expect(createPaymentMethod.code).toBe(mollieMockData.methodCode);
    });

    it('Should prepare an order of 10 items of 12.000 each', async () => {
        const { updateProductVariants } = await adminClient.query(updateProductVariantsDocument, {
            input: { id: 'T_5', price: 12000 },
        });
        expect(updateProductVariants[0].price).toBe(12000);
        expect(updateProductVariants[0].priceWithTax).toBe(14400);
        await shopClient.asUserWithCredentials(customers[0].emailAddress, 'test');
        const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
            productVariantId: 'T_5',
            quantity: 10,
        });
        order = addItemToOrder as FragmentOf<typeof testOrderFragment>;
        const ctx = new RequestContext({
            apiType: 'admin',
            isAuthorized: true,
            authorizedAsOwnerOnly: false,
            channel: await server.app.get(ChannelService).getDefaultChannel(),
        });
        await server.app.get(OrderService).addSurchargeToOrder(ctx, order.id.replace('T_', ''), {
            description: 'Negative test surcharge',
            listPrice: SURCHARGE_AMOUNT,
            taxLines: [{ description: 'Standard Tax', taxRate: 20 }],
        });
        await setShipping(shopClient);
        // Use the shipping method that has tax, so that the VAT of the shipping line is not 0
        const { eligibleShippingMethods } = await shopClient.query(getEligibleShippingMethodsDocument);
        const taxedShipping = eligibleShippingMethods.find(method => method.name === 'Express Shipping (Taxed)');
        await shopClient.query(setShippingMethodDocument, { id: [taxedShipping!.id] });
        expect(order.code).toBeDefined();
    });

    it('Should send the amounts of the payment and all lines in the precision of the store', async () => {
        let mollieRequest: any;
        nock('https://api.mollie.com/')
            .post('/v2/payments', body => {
                mollieRequest = body;
                return true;
            })
            .reply(200, mollieMockData.molliePaymentResponse);
        await shopClient.query(createMolliePaymentIntentDocument, {
            input: { paymentMethodCode: mollieMockData.methodCode },
        });
        // 144.000 for the items, 1.200 for the shipping (1.000 plus 20% tax) and -6.000 for the surcharge (-5.000 plus 20% tax)
        expect(mollieRequest.amount).toEqual({ value: '139.20', currency: 'USD' });
        const line = (description: string) =>
            mollieRequest.lines.find((l: any) => l.description === description);
        expect(line('Pinelab stickers')).toMatchObject({
            quantity: 10,
            unitPrice: { value: '14.40', currency: 'USD' },
            totalAmount: { value: '144.00', currency: 'USD' },
            vatAmount: { value: '24.00', currency: 'USD' },
        });
        expect(line('Shipping')).toMatchObject({
            quantity: 1,
            unitPrice: { value: '1.20', currency: 'USD' },
            totalAmount: { value: '1.20', currency: 'USD' },
            vatAmount: { value: '0.20', currency: 'USD' },
        });
        expect(line('Negative test surcharge')).toMatchObject({
            quantity: 1,
            unitPrice: { value: '-6.00', currency: 'USD' },
            totalAmount: { value: '-6.00', currency: 'USD' },
            vatAmount: { value: '-1.00', currency: 'USD' },
            type: 'store_credit',
        });
        const totalOfLines = mollieRequest.lines.reduce(
            (sum: number, l: any) => sum + Number(l.totalAmount.value),
            0,
        );
        expect(totalOfLines.toFixed(2)).toEqual(mollieRequest.amount.value);
    });

    it('Should deduct an earlier payment in the precision of the store', async () => {
        let mollieRequest: any;
        nock('https://api.mollie.com/')
            .post('/v2/payments', body => {
                mollieRequest = body;
                return true;
            })
            .reply(200, mollieMockData.molliePaymentResponse);
        await addManualPayment(server, 1, 10000); // 10.000
        await shopClient.query(createMolliePaymentIntentDocument, {
            input: { paymentMethodCode: mollieMockData.methodCode },
        });
        expect(mollieRequest.amount.value).toBe('129.20');
        const deduction = mollieRequest.lines.find((l: any) => l.description === 'Already paid');
        expect(deduction).toMatchObject({
            quantity: 1,
            unitPrice: { value: '-10.00', currency: 'USD' },
            totalAmount: { value: '-10.00', currency: 'USD' },
            type: 'store_credit',
        });
    });

    it('Should record the amount that Mollie reports as paid in the precision of the store', async () => {
        nock('https://api.mollie.com/')
            .get(`/v2/payments/${mollieMockData.molliePaymentResponse.id}`)
            .reply(200, {
                ...mollieMockData.molliePaymentResponse,
                // 129.20 is what is left to pay after the manual payment of 10.000
                amount: { value: '129.20', currency: 'USD' },
                description: order.code,
                status: OrderStatus.paid,
            });
        await fetch(`http://localhost:${serverPort}/payments/mollie/${E2E_DEFAULT_CHANNEL_TOKEN}/1`, {
            method: 'post',
            body: JSON.stringify({ id: mollieMockData.molliePaymentResponse.id }),
            headers: { 'Content-Type': 'application/json' },
        });
        const { order: adminOrder } = await adminClient.query(getOrderPaymentsDocument, { id: order.id });
        expect(adminOrder!.state).toBe('PaymentSettled');
        expect(adminOrder!.payments!.map(p => p.amount).sort((a, b) => a - b)).toEqual([10000, 129200]);
    });

    it('Should refund in the precision of the store', async () => {
        let mollieRequest: any;
        nock('https://api.mollie.com/')
            .get(`/v2/payments/${mollieMockData.molliePaymentResponse.id}`)
            .reply(200, mollieMockData.molliePaymentResponse);
        nock('https://api.mollie.com/')
            .post('/v2/payments/tr_mockPayment/refunds', body => {
                mollieRequest = body;
                return true;
            })
            .reply(200, { status: 'pending', resource: 'payment' });
        const { order: adminOrder } = await adminClient.query(getOrderPaymentsDocument, { id: order.id });
        const molliePayment = adminOrder!.payments!.find(p => p.amount === 129200)!;
        // Refund 5 of the 10 items: 5 x 14.400 = 72.000
        const refund = await refundOrderLine(adminClient, order.lines[0].id, 5, molliePayment.id, 0);
        expect(mollieRequest.amount).toEqual({ value: '72.00', currency: 'USD' });
        expect(refund.total).toBe(72000);
        expect(refund.state).toBe('Settled');
    });
});
