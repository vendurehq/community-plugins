import { PluginCommonModule, Type, VendurePlugin } from '@vendure/core';
import { raw } from 'body-parser';
import { gql } from 'graphql-tag';
import { YolfiOptions } from './yolfi-client';
import { YolfiController } from './yolfi.controller';
import { yolfiPaymentHandler } from './yolfi.handler';
import { YolfiResolver } from './yolfi.resolver';
import { YOLFI_OPTIONS, YolfiService } from './yolfi.service';

@VendurePlugin({
    imports: [PluginCommonModule],
    controllers: [YolfiController],
    providers: [YolfiService, { provide: YOLFI_OPTIONS, useFactory: () => YolfiPlugin.options }],
    configuration: config => {
        if (!YolfiPlugin.options) throw new Error('Initialize YolfiPlugin with server-side credentials');
        if (!['postgres', 'mysql', 'mariadb'].includes(config.dbConnectionOptions.type)) {
            throw new Error('Yolfi requires PostgreSQL, MySQL or MariaDB transactional row locks');
        }
        config.paymentOptions.paymentMethodHandlers.push(yolfiPaymentHandler);
        config.apiOptions.middleware.push({
            route: '/payments/yolfi', beforeListen: true,
            handler: raw({ type: 'application/json', limit: '64kb' }),
        });
        return config;
    },
    shopApiExtensions: {
        schema: gql`extend type Mutation { createYolfiCheckout(paymentMethodCode: String!, attemptId: String!): String! }`,
        resolvers: [YolfiResolver],
    },
    compatibility: '^3.6.0',
})
export class YolfiPlugin {
    static options: YolfiOptions;

    static init(options: YolfiOptions): Type<YolfiPlugin> {
        if (!options.apiKey?.trim() || !options.webhookSecret?.trim()) throw new Error('Yolfi credentials are required');
        for (const value of [options.successUrl, options.cancelUrl]) {
            const url = new URL(value);
            if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Yolfi return URLs must use HTTPS');
        }
        if (options.livemode !== undefined && typeof options.livemode !== 'boolean') throw new Error('Invalid Yolfi mode');
        this.options = { ...options };
        return YolfiPlugin;
    }
}
