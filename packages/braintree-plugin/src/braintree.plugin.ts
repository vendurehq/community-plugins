import { LanguageCode, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';
import { gql } from 'graphql-tag';

import { braintreePaymentMethodHandler } from './braintree.handler';
import { BraintreeResolver } from './braintree.resolver';
import { BRAINTREE_PLUGIN_OPTIONS } from './constants';
import { BraintreePluginOptions } from './types';

/**
 * @description
 * This plugin enables payments to be processed by [Braintree](https://www.braintreepayments.com/), a popular payment provider.
 *
 * @docsCategory BraintreePlugin
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [
        {
            provide: BRAINTREE_PLUGIN_OPTIONS,
            useFactory: () => BraintreePlugin.options,
        },
    ],
    configuration: config => {
        config.paymentOptions.paymentMethodHandlers.push(braintreePaymentMethodHandler);
        if (BraintreePlugin.options.storeCustomersInBraintree === true) {
            config.customFields.Customer.push({
                name: 'braintreeCustomerId',
                type: 'string',
                label: [{ languageCode: LanguageCode.en, value: 'Braintree Customer ID' }],
                nullable: true,
                public: false,
                readonly: true,
            });
        }
        return config;
    },
    shopApiExtensions: {
        schema: gql`
            extend type Query {
                generateBraintreeClientToken(orderId: ID, includeCustomerId: Boolean): String!
            }
        `,
        resolvers: [BraintreeResolver],
    },
    compatibility: '^3.0.0',
})
export class BraintreePlugin {
    static options: BraintreePluginOptions = {};
    static init(options: BraintreePluginOptions): Type<BraintreePlugin> {
        this.options = options;
        return BraintreePlugin;
    }
}
