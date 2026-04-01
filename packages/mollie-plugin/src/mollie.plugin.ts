import type { ListParameters } from '@mollie/api-client/dist/types/binders/methods/parameters';
import {
    Injector,
    Order,
    PluginCommonModule,
    RequestContext,
    RuntimeVendureConfig,
    VendurePlugin,
} from '@vendure/core';

import { adminApiExtensions, shopApiExtensions } from './api-extensions';
import { PLUGIN_INIT_OPTIONS } from './constants';
import { MollieCommonResolver } from './mollie.common-resolver';
import { MollieController } from './mollie.controller';
import { molliePaymentHandler } from './mollie.handler';
import { MollieService } from './mollie.service';
import { MollieShopResolver } from './mollie.shop-resolver';

export type AdditionalEnabledPaymentMethodsParams = Partial<Omit<ListParameters, 'resource'>>;

/**
 * @description
 * Configuration options for the Mollie payments plugin.
 *
 * @docsCategory MolliePlugin
 */
export interface MolliePluginOptions {
    /**
     * @description
     * The host of your Vendure server, e.g. `'https://my-vendure.io'`.
     * This is used by Mollie to send webhook events to the Vendure server
     */
    vendureHost: string;

    /**
     * @description
     * Provide additional parameters to the Mollie enabled payment methods API call. By default,
     * the plugin will already pass the `resource` parameter.
     *
     * For example, if you want to provide a `locale` and `billingCountry` for the API call, you can do so like this:
     *
     * **Note:** The `order` argument is possibly `null`, this could happen when you fetch the available payment methods
     * before the order is created.
     *
     * @example
     * ```ts
     * import { VendureConfig } from '\@vendure/core';
     * import { MolliePlugin, getLocale } from '\@vendure-community/mollie-plugin';
     *
     * export const config: VendureConfig = {
     *   // ...
     *   plugins: [
     *     MolliePlugin.init({
     *       enabledPaymentMethodsParams: (injector, ctx, order) => {
     *         const locale = order?.billingAddress?.countryCode
     *             ? getLocale(order.billingAddress.countryCode, ctx.languageCode)
     *             : undefined;
     *
     *         return {
     *           locale,
     *           billingCountry: order?.billingAddress?.countryCode,
     *         },
     *       }
     *     }),
     *   ],
     * };
     * ```
     *
     * @since 2.2.0
     */
    enabledPaymentMethodsParams?: (
        injector: Injector,
        ctx: RequestContext,
        order: Order | null,
    ) => AdditionalEnabledPaymentMethodsParams | Promise<AdditionalEnabledPaymentMethodsParams>;
    /**
     * @description
     * Immediate capture mode for pay-later methods like Klarna.
     * Setting this option will make the plugin ignore the `immediateCapture` option in the `createMolliePaymentIntent` mutation.
     *
     * The default is true, unless set otherwise as input in the `createMolliePaymentIntent` mutation.
     */
    immediateCapture?: boolean;
    /**
     * @description
     * Disable the processing of incoming Mollie webhooks.
     * Handle with care! This will keep orders in 'AddingItems' state if you don't manually process the Mollie payments via the `syncMolliePaymentStatus` mutation.
     *
     * @since 3.6.0
     */
    disableWebhookProcessing?: boolean;
}

/**
 * @description
 * Plugin to enable payments through the [Mollie platform](https://docs.mollie.com/).
 * This plugin uses the Order API from Mollie, not the Payments API.
 *
 * @docsCategory MolliePlugin
 * @docsWeight 0
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    controllers: [MollieController],
    providers: [MollieService, { provide: PLUGIN_INIT_OPTIONS, useFactory: () => MolliePlugin.options }],
    configuration: (config: RuntimeVendureConfig) => {
        config.paymentOptions.paymentMethodHandlers.push(molliePaymentHandler);
        return config;
    },
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [MollieCommonResolver, MollieShopResolver],
    },
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [MollieCommonResolver],
    },
    compatibility: '^3.0.0',
})
export class MolliePlugin {
    static options: MolliePluginOptions;

    /**
     * @description
     * Initialize the mollie payment plugin
     * @param vendureHost is needed to pass to mollie for callback
     */
    static init(options: MolliePluginOptions): typeof MolliePlugin {
        this.options = options;
        return MolliePlugin;
    }
}
