# Yolfi payment plugin

An external Vendure community plugin for native, one-time hosted Yolfi checkout. It registers a payment method handler beside existing providers; it does not modify Vendure core or use a Stripe-compatible API. This is a proposed workspace package, not a claim of an existing published release.

## Supported flow

1. Complete the normal Vendure checkout preparation and transition the active order to `ArrangingPayment`.
2. Call `createYolfiCheckout` in the owner's Shop API session and redirect to the returned hosted URL.
3. Receive a native, signed `payment.confirmed` webhook. The plugin checks the exact raw-body HMAC-SHA256 base64 signature, mode, one-time invoice, order/channel/method correlation and authenticated Checkout Session pricing snapshot before adding a full `Settled` payment.
4. Vendure's existing payment/order state machine controls fulfillment. Neither a return URL nor `CheckoutSession.status = COMPLETED` alone is proof of payment.

Requires Node.js 20+, Vendure 3.6+ and PostgreSQL, MySQL or MariaDB. Other databases fail at configuration rather than silently skipping the row lock. Keep the default order/payment state machines, or verify equivalent behavior in your own customization. One Yolfi organization/API key and one webhook signing secret are configured per server; all enabled channels use that account. Separate credentials per channel are not supported.

## Server setup

Build the workspace package using the repository's normal build workflow. Add it to `plugins` in your Vendure configuration:

```ts
import { YolfiPlugin } from '@vendure-community/yolfi-plugin';

plugins: [
    // Existing plugins remain unchanged.
    YolfiPlugin.init({
        apiKey: process.env.YOLFI_API_KEY!,
        webhookSecret: process.env.YOLFI_WEBHOOK_SECRET!,
        successUrl: 'https://shop.example.com/checkout/result',
        cancelUrl: 'https://shop.example.com/cart',
        livemode: true,
    }),
]
```

Use server-managed secrets, never storefront arguments or payment-method configuration fields. Return URLs are fixed HTTPS URLs. Enable the `yolfi` handler on a payment method and assign that method to the intended channels. No handler arguments are needed. The normal payment-method eligibility checker still applies.

Configure one native Yolfi webhook endpoint at `https://shop.example.com/payments/yolfi`, with `payment.confirmed` enabled, and configure its signing secret above. Do not select an adapter format. Preserve the incoming `X-Yolfi-Signature` header. The plugin registers a bounded raw JSON parser before Vendure's normal body parsing; do not add another parser or middleware that consumes this route first. Set `livemode: false` only for a separately configured sandbox endpoint/key/secret.

## Storefront

```graphql
mutation CreateYolfiCheckout($method: String!, $attempt: String!) {
    createYolfiCheckout(paymentMethodCode: $method, attemptId: $attempt)
}
```

Use the enabled payment method's code for `method`. Generate an `attempt` with `crypto.randomUUID()` and persist it for that order's current checkout attempt. Retry network failures with the same identifier. Start a new identifier only when deliberately starting a new attempt, including after expiration. Identifiers must contain 16–100 letters, digits, hyphens or underscores. Idempotency keys are additionally scoped by the server-derived order/channel/method, amount, currency and fixed URLs. Changed totals use a different key. Several hosted attempts can exist, but only one full-order payment can be applied.

Use the normal Shop API authentication/session and channel header. No caller-supplied order ID, amount, customer information, redirect URL or payment status is accepted. Do not call `addPaymentToOrder` from the storefront: payment creation requires a signed event in an internal Admin context. Poll Vendure's order state after returning; a redirect is not confirmation.

## Money, retries and limitations

Amounts are formatted exactly from Vendure's configured `MoneyStrategy.precision` (default 2), not an assumed ISO minor-unit exponent. Safe positive integer order totals only; no floating-point rounding. Supported pricing currencies are USD, EUR, CNY, RUB, INR, TRY, KRW and JPY, with a minimum of 0.01 in that currency.

Native webhook `amount` is a payment-token receivable and `amountUsd` is its USD equivalent; neither is compared to the order total. The plugin uses the signed session ID to retrieve the authenticated immutable `amount`, `currency` and `merchantOrderId` snapshot and verifies that against the current server-calculated full order total. A matching session snapshot must accompany a signed confirmed invoice.

Webhook processing locks the order before its first transactional read and commits the payment atomically. Repeated/concurrent deliveries of an already recorded invoice/session do not add another payment. HTTP failures, malformed responses, mismatched totals/references, framework errors or unsuccessful persistence are not acknowledged as successful handling; Yolfi can retry. Remote calls use a 10-second deadline and reject redirects. Reconcile permanently mismatched, already-cancelled or changed orders manually. If a different attempt is paid after settlement, it is not applied as a second order payment and requires manual reconciliation.

Cancellation/expiration/overdue and unrelated events do not create payments or authorize funds; the order remains unpaid. A buyer can return to the cart and start another attempt. This plugin cannot cancel an already-issued remote checkout. There is no card processing, automatic renewal, subscription support, partial/mixed-tender payment, history sync, manual capture or API refund support. Vendure refund/capture/cancel operations explicitly reject; do not use them to imply a remote operation occurred. Handle any required reconciliation outside this integration.

Only invoice/session/event references are retained in payment metadata; raw event bodies, signatures and customer details are not stored. No customer fields are sent in checkout creation.

## Focused tests

From this package, run `node test/yolfi.spec.cjs` with the workspace TypeScript development dependency available. An optional compiler-module path may be passed as the first argument. Tests transpile and execute the actual adapter, handler, service, controller, resolver and plugin configuration. Only external HTTP and framework/database collaborators are mocked. All responses are synthetic fixtures; no network, real payment, database, application boot or upstream CI is exercised. Concurrency assertions test the adapter's lock/deduplication orchestration with a mocked transactional database, not a real database isolation guarantee.

## Public contract

- [Checkout Sessions API](https://docs.yolfi.com/en/checkout/api-reference)
- [Checkout lifecycle](https://docs.yolfi.com/en/checkout/lifecycle)
- [Webhook object fields](https://docs.yolfi.com/en/webhooks/webhook-details)
- [Raw-body webhook signatures](https://docs.yolfi.com/en/webhooks/webhook-signatures)
