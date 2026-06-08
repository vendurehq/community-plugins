import { GraphiqlPlugin } from '@vendure/graphiql-plugin';
import {
    ChannelService,
    DefaultLogger,
    LanguageCode,
    Logger,
    LogLevel,
    mergeConfig,
    OrderService,
    RequestContext,
} from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer } from '@vendure/testing';
import path from 'path';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { testConfig } from '../../../e2e-common/test-config';
import { StripePlugin } from '../src';
import { stripePaymentMethodHandler } from '../src/stripe.handler';

import { StripeCheckoutTestPlugin } from './fixtures/stripe-checkout-test.plugin';
import { StripeServiceExportTestPlugin } from './fixtures/stripe-service-export-test.plugin';
import { createPaymentMethodDocument } from './graphql/admin-definitions';
import { graphql as shopGraphql } from './graphql/graphql-shop';
import { createStripePaymentIntentDocument } from './graphql/shared-definitions';
import { addItemToOrderDocument } from './graphql/shop-definitions';
import { setShipping } from './payment-helpers';

export let clientSecret: string;

const createCustomStripePaymentIntentDocument = shopGraphql(`
    mutation CreateCustomStripePaymentIntent($orderCode: String!, $channelToken: String!) {
        createCustomStripePaymentIntent(orderCode: $orderCode, channelToken: $channelToken)
    }
`);

/**
 * Locally test the Stripe payment plugin against a real Stripe test account.
 *
 *   1. Put STRIPE_APIKEY, STRIPE_WEBHOOK_SECRET, STRIPE_PUBLISHABLE_KEY in a
 *      `.env` next to this file (or in your shell).
 *   2. Run `stripe listen --forward-to localhost:3050/payments/stripe` and
 *      paste the resulting signing secret as STRIPE_WEBHOOK_SECRET.
 *   3. `npm run dev-server` — then open http://localhost:3050/checkout.
 */
(async () => {
    require('dotenv').config();
    const testConfigInstance = testConfig();
    registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));
    const config = mergeConfig(testConfigInstance, {
        plugins: [
            ...testConfigInstance.plugins,
            GraphiqlPlugin.init({ route: 'graphiql' }),
            StripePlugin.init({}),
            StripeCheckoutTestPlugin,
            StripeServiceExportTestPlugin,
        ],
        logger: new DefaultLogger({ level: LogLevel.Debug }),
        apiOptions: {
            ...testConfigInstance.apiOptions,
            adminApiPlayground: true,
            shopApiPlayground: true,
        },
    });
    const { server, shopClient, adminClient } = createTestEnvironment(config);
    await server.init({
        initialData,
        productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
        customerCount: 1,
    });
    await adminClient.asSuperAdmin();
    await adminClient.query(createPaymentMethodDocument, {
        input: {
            code: 'stripe-payment-method',
            enabled: true,
            translations: [
                {
                    name: 'Stripe',
                    description: 'This is a Stripe test payment method',
                    languageCode: LanguageCode.en,
                },
            ],
            handler: {
                code: stripePaymentMethodHandler.code,
                arguments: [
                    { name: 'apiKey', value: process.env.STRIPE_APIKEY! },
                    { name: 'webhookSecret', value: process.env.STRIPE_WEBHOOK_SECRET! },
                ],
            },
        },
    });
    await shopClient.asUserWithCredentials('hayden.zieme12@hotmail.com', 'test');
    await shopClient.query(addItemToOrderDocument, {
        productVariantId: 'T_1',
        quantity: 1,
    });
    const ctx = new RequestContext({
        apiType: 'admin',
        isAuthorized: true,
        authorizedAsOwnerOnly: false,
        channel: await server.app.get(ChannelService).getDefaultChannel(),
    });
    await server.app.get(OrderService).addSurchargeToOrder(ctx, 1, {
        description: 'Negative test surcharge',
        listPrice: -20000,
    });
    await setShipping(shopClient);
    const { createStripePaymentIntent } = await shopClient.query(createStripePaymentIntentDocument);
    clientSecret = createStripePaymentIntent as string;

    Logger.info('http://localhost:3050/checkout', 'Stripe DevServer');
    Logger.info('http://localhost:3050/graphiql', 'Stripe DevServer');
})();
