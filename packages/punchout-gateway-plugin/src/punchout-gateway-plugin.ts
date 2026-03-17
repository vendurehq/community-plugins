import { LanguageCode, PluginCommonModule, RuntimeVendureConfig, VendurePlugin } from '@vendure/core';

import { shopApiExtensions } from './api/api-extensions';
import { PunchOutGatewayResolver } from './api/punchout-gateway.resolver';
import { PUNCHOUT_GATEWAY_PLUGIN_OPTIONS, TRANSFERRED_ORDER_STATE } from './constants';
import { PunchOutActiveOrderStrategy } from './punchout-active-order-strategy';
import { PunchOutAuthenticationStrategy } from './punchout-authentication-strategy';
import { PunchOutGatewayService } from './service/punchout-gateway.service';
import { PunchOutGatewayPluginOptions } from './types';

declare module '@vendure/core' {
    interface CustomOrderStates {
        Transferred: never;
    }
}

const PunchOutOptionsProvider = {
    provide: PUNCHOUT_GATEWAY_PLUGIN_OPTIONS,
    useFactory: () => PunchOutGatewayPlugin.options,
};

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [PunchOutOptionsProvider, PunchOutGatewayService],
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [PunchOutGatewayResolver],
    },
    configuration: (config: RuntimeVendureConfig) => {
        config.orderOptions.process = [
            ...(config.orderOptions.process ?? []),
            {
                transitions: {
                    AddingItems: {
                        to: [TRANSFERRED_ORDER_STATE],
                    },
                    [TRANSFERRED_ORDER_STATE]: {
                        to: [],
                    },
                },
                onTransitionEnd(fromState, toState, data) {
                    if (toState === TRANSFERRED_ORDER_STATE) {
                        data.order.active = false;
                    }
                },
            },
        ];
        config.authOptions.shopAuthenticationStrategy = [
            ...config.authOptions.shopAuthenticationStrategy,
            new PunchOutAuthenticationStrategy(),
        ];
        config.orderOptions.activeOrderStrategy = [
            new PunchOutActiveOrderStrategy(),
            ...(Array.isArray(config.orderOptions.activeOrderStrategy)
                ? config.orderOptions.activeOrderStrategy
                : [config.orderOptions.activeOrderStrategy]),
        ];
        config.customFields.Customer = [
            ...(config.customFields.Customer ?? []),
            {
                name: 'punchOutUid',
                type: 'string',
                nullable: true,
                public: false,
                label: [{ languageCode: LanguageCode.en, value: 'PunchOut Customer ID (uID)' }],
                description: [{
                    languageCode: LanguageCode.en,
                    value: 'The customer identifier from PunchCommerce. Set this to link the customer to a PunchOut session.',
                }],
            },
        ];
        config.customFields.Order = [
            ...(config.customFields.Order ?? []),
            {
                name: 'punchOutSessionId',
                type: 'string',
                nullable: true,
                public: false,
                internal: true,
            },
        ];
        return config;
    },
    compatibility: '^3.0.0',
})
export class PunchOutGatewayPlugin {
    static options: PunchOutGatewayPluginOptions;

    static init(options: PunchOutGatewayPluginOptions): typeof PunchOutGatewayPlugin {
        this.options = options;
        return this;
    }
}
