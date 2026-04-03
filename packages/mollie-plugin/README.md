# Mollie Payment Plugin

Plugin to enable payments through the [Mollie platform](https://docs.mollie.com/).
This plugin uses the Order API from Mollie, not the Payments API.

## Requirements

1. You will need to create a Mollie account and get your api key from the Mollie dashboard.
2. Install the Payments plugin and the Mollie client:

    `yarn add @vendure-community/mollie-plugin @mollie/api-client`

    or

    `npm install @vendure-community/mollie-plugin @mollie/api-client`

## Setup

1. Add the plugin to your VendureConfig `plugins` array:
    ```ts
    import { MolliePlugin } from '@vendure-community/mollie-plugin';

    // ...

    plugins: [
      MolliePlugin.init({ vendureHost: 'https://yourhost.io/' }),
    ]
    ```
2. Create a new payment method in the Admin UI, and select "Mollie payments" as the handler.
3. Set your Mollie apiKey in the `API Key` field.
4. Set the `Fallback redirectUrl` to the url that the customer should be redirected to after completing the payment.
You can override this url by passing the `redirectUrl` as an argument to the `createMolliePaymentIntent` mutation.

## Storefront Usage

In your storefront you add a payment to an order using the `createMolliePaymentIntent` mutation. In this example, our Mollie
payment method was given the code "mollie-payment-method". The `redirectUrl` should be your order confirmation page.
It is the url that is used to redirect the customer back to your storefront after completing the payment.

```graphql
mutation CreateMolliePaymentIntent {
  createMolliePaymentIntent(input: {
    redirectUrl: "https://storefront/order/1234XYZ" # Optional, the fallback redirect url set in the admin UI will be used if not provided
    paymentMethodCode: "mollie-payment-method" # Optional, the first method with Mollie as handler will be used if not provided
    molliePaymentMethodCode: "ideal" # Optional argument to skip the method selection in the hosted checkout
    locale: "nl_NL" # Optional, the browser language will be used by Mollie if not provided
    immediateCapture: true # Optional, default is true, set to false if you expect the order fulfillment to take longer than 24 hours
  }) {
         ... on MolliePaymentIntent {
              url
          }
         ... on MolliePaymentIntentError {
              errorCode
              message
         }
  }
}
```

You can use `molliePaymentIntent.url` to redirect the customer to the Mollie platform.

The `molliePaymentMethodCode` is an optional parameter that can be passed to preselect a payment method, and skip Mollie's payment method selection screen.
You can get available Mollie payment methods with the following query:

```graphql
{
 molliePaymentMethods(input: { paymentMethodCode: "mollie-payment-method" }) {
   id
   code
   description
   minimumAmount {
     value
     currency
   }
   maximumAmount {
     value
     currency
   }
   image {
     size1x
     size2x
     svg
   }
 }
}
```

After completing payment on the Mollie platform,
the user is redirected by Mollie to the provided redirect url (confirmation page).
E.g. `https://storefront/order/`. The redirect url here was `https://storefront/order`, the order code `CH234X5` is appended automatically by the plugin.

### Force Payment Status Update

Mollie does not give any guarantees on webhook delivery time, and in some rare cases,
the Mollie webhook is delayed and the order status is not updated in Vendure.

You can use the `syncMolliePaymentStatus` mutation to force update the order status based on the Mollie payment status.
This mutation will find any settled or authorized Mollie payments for the given order and update the order status in Vendure accordingly.

```graphql
mutation SyncMolliePaymentStatus {
  syncMolliePaymentStatus(orderCode: "CH234X5") {
    id
    state
  }
}
```

You should wait for an incoming webhook first, because due to technical limitations on the Mollie API, the `syncMolliePaymentStatus`
mutation will iterate through the last 500 Mollie payments to find the payments for the given order.
Hence, it is not very performant, and should only be used as a fallback when a webhook
was not received for ~10 seconds.

## Pay Later Methods

Mollie supports pay-later methods like 'Klarna Pay Later'. Pay-later methods are captured immediately after payment.

If your order fulfillment time is longer than 24 hours you should pass `immediateCapture=false` to the `createMolliePaymentIntent` mutation.
This will transition your order to 'PaymentAuthorized' after the Mollie hosted checkout.
You need to manually capture the payment after the order is fulfilled, by settling existing payments, either via the admin UI or in custom code.

Make sure to capture a payment within 28 days, after that the payment will be automatically released.
See the [Mollie documentation](https://docs.mollie.com/docs/place-a-hold-for-a-payment#authorization-expiration-window)
for more information.

## ArrangingAdditionalPayment State

In some cases, a customer can add items to the active order, while a Mollie checkout is still open, or an administrator can modify an order.
Both of these actions will result in an order being in `ArrangingAdditionalPayment` status.
To finalize an order in `ArrangingAdditionalPayment` status, you can use call the `createMolliePaymentIntent` mutation again with an additional `orderId` as input.
The `orderId` argument is needed, because an order in `ArrangingAdditionalPayment` status is not an active order anymore.
