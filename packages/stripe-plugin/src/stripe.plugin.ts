import { LanguageCode, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';
import { gql } from 'graphql-tag';

import { STRIPE_PLUGIN_OPTIONS } from './constants';
import { rawBodyMiddleware } from './raw-body.middleware';
import { StripeController } from './stripe.controller';
import { setStripeCredentialsEncrypted, stripePaymentMethodHandler } from './stripe.handler';
import { StripeResolver } from './stripe.resolver';
import { StripeService } from './stripe.service';
import { StripePluginOptions } from './types';

/**
 * @description
 * Plugin to enable payments through [Stripe](https://stripe.com/docs) via the Payment Intents API.
 *
 * @docsCategory StripePlugin
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    controllers: [StripeController],
    providers: [
        {
            provide: STRIPE_PLUGIN_OPTIONS,
            useFactory: (): StripePluginOptions => StripePlugin.options,
        },
        StripeService,
    ],
    configuration: config => {
        const encryptSecrets = StripePlugin.options.encryptSecrets === true;
        // Vendure < 3.8 ignores the `secret` flag, which would leave the credentials in plain text
        // while the config says they are encrypted.
        if (encryptSecrets && !('encryptionStrategy' in config.systemOptions)) {
            throw new Error(
                'The StripePlugin `encryptSecrets` option requires Vendure 3.8.0 or later. ' +
                    'Upgrade Vendure, or remove the option to store the credentials in plain text.',
            );
        }
        setStripeCredentialsEncrypted(encryptSecrets);
        config.paymentOptions.paymentMethodHandlers.push(stripePaymentMethodHandler);

        config.apiOptions.middleware.push({
            route: '/payments/stripe',
            handler: rawBodyMiddleware,
            beforeListen: true,
        });

        if (StripePlugin.options.storeCustomersInStripe) {
            config.customFields.Customer.push({
                name: 'stripeCustomerId',
                type: 'string',
                label: [{ languageCode: LanguageCode.en, value: 'Stripe Customer ID' }],
                nullable: true,
                public: false,
                readonly: true,
            });
        }

        return config;
    },
    shopApiExtensions: {
        schema: gql`
            extend type Mutation {
                createStripePaymentIntent: String!
            }
        `,
        resolvers: [StripeResolver],
    },
    exports: [StripeService],
    compatibility: '^3.0.0',
})
export class StripePlugin {
    static options: StripePluginOptions;

    /**
     * @description
     * Initialize the Stripe payment plugin
     */
    static init(options: StripePluginOptions): Type<StripePlugin> {
        this.options = options;
        return StripePlugin;
    }
}
