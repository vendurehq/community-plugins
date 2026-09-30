import type { Injector, Order, RequestContext } from '@vendure/core';
import '@vendure/core/dist/entity/custom-entity-fields';
import type { Request } from 'express';
import type Stripe from 'stripe';

// Note: deep import is necessary here because CustomCustomerFields is also extended in the Braintree
// plugin. Reference: https://github.com/microsoft/TypeScript/issues/46617
declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomCustomerFields {
        stripeCustomerId?: string;
    }
}

type AdditionalPaymentIntentCreateParams = Partial<
    Omit<Stripe.PaymentIntentCreateParams, 'amount' | 'currency' | 'customer'>
>;

type AdditionalRequestOptions = Partial<Omit<Stripe.RequestOptions, 'idempotencyKey'>>;

type AdditionalCustomerCreateParams = Partial<Omit<Stripe.CustomerCreateParams, 'email'>>;

/**
 * @description
 * Configuration options for the Stripe payments plugin.
 *
 * @docsCategory StripePlugin
 */
export interface StripePluginOptions {
    /**
     * @description
     * If set to `true`, a [Customer](https://stripe.com/docs/api/customers) object will be created in Stripe - if
     * it doesn't already exist - for authenticated users, which prevents payment methods attached to other Customers
     * to be used with the same PaymentIntent. This is done by adding a custom field to the Customer entity to store
     * the Stripe customer ID, so switching this on will require a database migration / synchronization.
     *
     * @default false
     */
    storeCustomersInStripe?: boolean;

    /**
     * @description
     * Controls how the PaymentIntent captures funds.
     *
     * `'automatic'` (the default) charges the card as soon as the customer confirms payment, which
     * is the plugin's historic behaviour.
     *
     * `'manual'` uses Stripe's separate authorization and capture flow. Confirming the payment only
     * places a hold on the funds (PaymentIntent status `requires_capture`). The plugin then adds an
     * `Authorized` payment to the order so Vendure can allocate stock, and captures the funds only
     * once the order safely reaches `PaymentAuthorized`. If the order cannot be arranged (for example
     * the item sold out during checkout), the authorization is voided instead of charged, so the
     * customer is never charged for an order that cannot be fulfilled.
     *
     * Manual capture requires the `payment_intent.amount_capturable_updated` webhook event to be
     * enabled, and only applies to payment methods that support authorize-then-capture (cards and
     * several others). See the plugin README for details.
     *
     * @default 'automatic'
     * @since 3.2.0
     */
    captureMethod?: 'automatic' | 'manual';

    /**
     * @description
     * Attach extra metadata to Stripe payment intent creation call.
     *
     * @example
     * ```ts
     * import { EntityHydrator, VendureConfig } from '\@vendure/core';
     * import { StripePlugin } from '\@vendure-community/stripe-plugin';
     *
     * export const config: VendureConfig = {
     *   // ...
     *   plugins: [
     *     StripePlugin.init({
     *       metadata: async (injector, ctx, order) => {
     *         const hydrator = injector.get(EntityHydrator);
     *         await hydrator.hydrate(ctx, order, { relations: ['customer'] });
     *         return {
     *           description: `Order #${order.code} for ${order.customer!.emailAddress}`
     *         },
     *       }
     *     }),
     *   ],
     * };
     * ```
     *
     * Note: If the `paymentIntentCreateParams` is also used and returns a `metadata` key, then the values
     * returned by both functions will be merged.
     *
     * @since 1.9.7
     */
    metadata?: (
        injector: Injector,
        ctx: RequestContext,
        order: Order,
    ) => Stripe.MetadataParam | Promise<Stripe.MetadataParam>;

    /**
     * @description
     * Provide additional parameters to the Stripe payment intent creation. By default,
     * the plugin will already pass the `amount`, `currency`, `customer` and `automatic_payment_methods: { enabled: true }` parameters.
     *
     * For example, if you want to provide a `description` for the payment intent, you can do so like this:
     *
     * @example
     * ```ts
     * import { VendureConfig } from '\@vendure/core';
     * import { StripePlugin } from '\@vendure-community/stripe-plugin';
     *
     * export const config: VendureConfig = {
     *   // ...
     *   plugins: [
     *     StripePlugin.init({
     *       paymentIntentCreateParams: (injector, ctx, order) => {
     *         return {
     *           description: `Order #${order.code} for ${order.customer?.emailAddress}`
     *         },
     *       }
     *     }),
     *   ],
     * };
     * ```
     *
     * Note: a `capture_method` returned here is ignored. The plugin's `captureMethod` option is
     * authoritative, since the payment handler and webhook flow depend on it, so the intent is
     * always created with the configured mode and a conflicting value is logged and dropped.
     *
     * @since 2.1.0
     *
     */
    paymentIntentCreateParams?: (
        injector: Injector,
        ctx: RequestContext,
        order: Order,
    ) => AdditionalPaymentIntentCreateParams | Promise<AdditionalPaymentIntentCreateParams>;

    /**
     * @description
     * Provide additional options to the Stripe payment intent creation. By default,
     * the plugin will already pass the `idempotencyKey` parameter.
     *
     * For example, if you want to provide a `stripeAccount` for the payment intent, you can do so like this:
     *
     * @example
     * ```ts
     * import { VendureConfig } from '\@vendure/core';
     * import { StripePlugin } from '\@vendure-community/stripe-plugin';
     *
     * export const config: VendureConfig = {
     *   // ...
     *   plugins: [
     *     StripePlugin.init({
     *       requestOptions: (injector, ctx, order) => {
     *         return {
     *           stripeAccount: ctx.channel.seller?.customFields.connectedAccountId
     *         },
     *       }
     *     }),
     *   ],
     * };
     * ```
     *
     * @since 3.1.0
     *
     */
    requestOptions?: (
        injector: Injector,
        ctx: RequestContext,
        order: Order,
    ) => AdditionalRequestOptions | Promise<AdditionalRequestOptions>;

    /**
     * @description
     * Provide additional parameters to the Stripe customer creation. By default,
     * the plugin will already pass the `email` and `name` parameters.
     *
     * For example, if you want to provide an address for the customer:
     *
     * @example
     * ```ts
     * import { EntityHydrator, VendureConfig } from '\@vendure/core';
     * import { StripePlugin } from '\@vendure-community/stripe-plugin';
     *
     * export const config: VendureConfig = {
     *   // ...
     *   plugins: [
     *     StripePlugin.init({
     *       storeCustomersInStripe: true,
     *       customerCreateParams: async (injector, ctx, order) => {
     *         const entityHydrator = injector.get(EntityHydrator);
     *         const customer = order.customer;
     *         await entityHydrator.hydrate(ctx, customer, { relations: ['addresses'] });
     *         const defaultBillingAddress = customer.addresses.find(a => a.defaultBillingAddress) ?? customer.addresses[0];
     *         return {
     *           address: {
     *               line1: defaultBillingAddress.streetLine1 || order.shippingAddress?.streetLine1,
     *               postal_code: defaultBillingAddress.postalCode || order.shippingAddress?.postalCode,
     *               city: defaultBillingAddress.city || order.shippingAddress?.city,
     *               state: defaultBillingAddress.province || order.shippingAddress?.province,
     *               country: defaultBillingAddress.country.code || order.shippingAddress?.countryCode,
     *           },
     *         },
     *       }
     *     }),
     *   ],
     * };
     * ```
     *
     * @since 2.1.0
     */
    customerCreateParams?: (
        injector: Injector,
        ctx: RequestContext,
        order: Order,
    ) => AdditionalCustomerCreateParams | Promise<AdditionalCustomerCreateParams>;
    /**
     * @description
     * If your Stripe account also generates payment intents which are independent of Vendure orders, you can set this
     * to `true` to skip processing those payment intents.
     */
    skipPaymentIntentsWithoutExpectedMetadata?: boolean;
}

export interface RequestWithRawBody extends Request {
    rawBody: Buffer;
}
