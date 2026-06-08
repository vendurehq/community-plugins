# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## 2.0.0

Major modernization release. Brings the plugin onto the current Stripe SDK and aligns it with the
2026 (`dahlia`) API version.

### Breaking changes

- **`stripe` peer dependency: `13.x` → `^22.0.0`.** Bump `stripe` in your project to a matching
  version when upgrading. The wire-format and TypeScript types have been updated to match.
- **Default Stripe API version is now pinned to the SDK's latest (`2026-05-27.dahlia`)** instead of
  sending no version header (which previously fell back to the Stripe account default). This keeps
  responses aligned with the SDK's typings. If your integration relied on the account default —
  e.g. because you've held off upgrading API versions in the Stripe dashboard — set the new
  `apiVersion` plugin option to `null` to restore the old behaviour:

  ```ts
  StripePlugin.init({
      // ...
      apiVersion: null,
  });
  ```

  To pin to a specific version other than the SDK default, pass it as a string (cast to
  `StripeLatestApiVersion`).
- **HTTP transport switched from `node:http`/`node:https` to the platform `fetch`.** The plugin
  configures Stripe's `FetchHttpClient` so the SDK uses `globalThis.fetch` (Node 18+, which is the
  minimum the SDK supports). Behaviour is functionally identical for normal use; if you relied on
  custom `http.Agent` settings (proxies, keep-alive tuning) injected into the previous transport,
  reach out — we'll add an explicit hook.

### Improvements

- **Refund `reason` is forwarded.** When the Vendure refund input includes a `reason` matching
  one of Stripe's accepted enum values (`duplicate`, `fraudulent`, `requested_by_customer`), it is
  passed as the structured `reason` field. Any other reason string is stored on the Stripe refund's
  metadata as `vendureRefundReason` so it isn't lost.
- **Refund creation is now idempotent.** `refunds.create` is called with an idempotency key derived
  from the payment intent ID and refund amount, matching the parity already in place for payment
  intent creation.

### Development

- `nock` 13 → 14, `rimraf` 5 → 6.

## 1.0.0 (2026-03-30)

Initial release as `@vendure-community/stripe-plugin`, extracted from `@vendure/payments-plugin`.
Equivalent to the functionality in Vendure core v3.5.6.

No additional feature changes from the v3.6.0 development branch.
