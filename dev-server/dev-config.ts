import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import {
    DefaultJobQueuePlugin,
    DefaultLogger,
    DefaultSearchPlugin,
    dummyPaymentHandler,
    LogLevel,
    VendureConfig,
} from '@vendure/core';
import { GraphiqlPlugin } from '@vendure/graphiql-plugin';
import 'dotenv/config';
import path from 'path';
import { DataSourceOptions } from 'typeorm';

// Import community plugins for development & testing.
// Uncomment the plugins you want to work on:

// import { ElasticsearchPlugin } from '../packages/elasticsearch-plugin/src/plugin';
// import { StripePlugin } from '../packages/payments-plugin/src/stripe/stripe.plugin';
// import { MolliePlugin } from '../packages/payments-plugin/src/mollie/mollie.plugin';
// import { BraintreePlugin } from '../packages/payments-plugin/src/braintree/braintree.plugin';
// import { SentryPlugin } from '../packages/sentry-plugin/src/sentry-plugin';
// import { StellatePlugin } from '../packages/stellate-plugin/src/stellate-plugin';
// import { PubSubPlugin } from '../packages/pub-sub-plugin/src/plugin';

/**
 * Dev server config for testing community plugins during development.
 *
 * Usage:
 *   1. Uncomment the plugin imports above that you want to test
 *   2. Add them to the `plugins` array below
 *   3. Run `npm run populate` then `npm run dev`
 */
export const devConfig: VendureConfig = {
    apiOptions: {
        port: 3000,
        adminApiPath: 'admin-api',
        adminApiPlayground: {
            settings: { 'request.credentials': 'include' },
        },
        adminApiDebug: true,
        shopApiPath: 'shop-api',
        shopApiPlayground: {
            settings: { 'request.credentials': 'include' },
        },
        shopApiDebug: true,
    },
    authOptions: {
        tokenMethod: ['bearer', 'cookie'] as const,
        requireVerification: false,
        cookieOptions: {
            secret: 'dev-secret',
        },
    },
    dbConnectionOptions: {
        ...getDbConfig(),
        synchronize: false,
    },
    paymentOptions: {
        paymentMethodHandlers: [dummyPaymentHandler],
    },
    logger: new DefaultLogger({ level: LogLevel.Verbose }),
    importExportOptions: {
        importAssetsDir: path.join(__dirname, 'import-assets'),
    },
    plugins: [
        GraphiqlPlugin.init(),
        AssetServerPlugin.init({
            route: 'assets',
            assetUploadDir: path.join(__dirname, 'assets'),
        }),
        DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: false }),
        DefaultJobQueuePlugin.init({}),

        // --- Community plugins ---
        // Uncomment plugins you want to develop/test:

        // ElasticsearchPlugin.init({
        //     host: 'http://localhost',
        //     port: 9200,
        // }),

        // StripePlugin.init({
        //     storeCustomersInStripe: true,
        // }),

        // SentryPlugin.init({
        //     includeErrorTestMutation: true,
        // }),
    ],
};

function getDbConfig(): DataSourceOptions {
    const dbType = process.env.DB || 'sqlite';
    switch (dbType) {
        case 'postgres':
            console.log('Using postgres connection');
            return {
                synchronize: true,
                type: 'postgres',
                host: process.env.DB_HOST || 'localhost',
                port: Number(process.env.DB_PORT) || 5432,
                username: process.env.DB_USERNAME || 'vendure',
                password: process.env.DB_PASSWORD || 'password',
                database: process.env.DB_NAME || 'vendure-dev',
            };
        case 'mysql':
        case 'mariadb':
            console.log('Using mysql/mariadb connection');
            return {
                synchronize: true,
                type: 'mariadb',
                host: '127.0.0.1',
                port: 3306,
                username: 'vendure',
                password: 'password',
                database: 'vendure-dev',
            };
        case 'sqlite':
        default:
            console.log('Using sqlite connection');
            return {
                synchronize: true,
                type: 'better-sqlite3',
                database: path.join(__dirname, 'vendure.sqlite'),
            };
    }
}
