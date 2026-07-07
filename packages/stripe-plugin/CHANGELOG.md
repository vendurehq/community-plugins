# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## 2.0.0

Major modernization release. Brings the plugin onto the current Stripe SDK and aligns it with the
2026 (`dahlia`) API version.

### Breaking changes

- **`stripe` peer dependency: `13.x` → `^22.0.0`.** Bump `stripe` in your project to a matching
  version when upgrading. The wire-format and TypeScript types have been updated to match.
- **Default Stripe API version is now pinned to the SDK's latest (`2026-05-27.dahlia`).** Pre-2.0.0,
  the plugin passed `apiVersion: null` and assumed the Stripe SDK would omit the `Stripe-Version`
  header so the request would fall back to the Stripe account's default API version. In practice
  the SDK has always coerced `null` to its own pinned default (see `props.apiVersion || DEFAULT_API_VERSION`
  in `stripe.core.js`) — both on v13 and v22 — so the previous behaviour was already the SDK pinned
  version (just an older one). With this release the responses will now come back shaped according
  to dahlia rather than 2023-08-16.

  If your code expects the older response shape, pin to the older version via the new `apiVersion`
  option:

  ```ts
  import type { StripeLatestApiVersion } from '@vendure-community/stripe-plugin';

  StripePlugin.init({
      // ...
      apiVersion: '2023-08-16' as StripeLatestApiVersion,
  });
  ```

  There is no way on stripe-node v22 to instruct the SDK to omit the version header entirely.
- **HTTP transport switched from `node:http`/`node:https` to the platform `fetch`.** The plugin
  configures Stripe's `FetchHttpClient` so the SDK uses `globalThis.fetch` (Node 18+, which is the
  minimum the SDK supports). Behaviour is functionally identical for normal use; if you relied on a
  custom `http.Agent` (proxies, keep-alive tuning), pass your own `Stripe.createNodeHttpClient(...)`
  via the new `httpClient` plugin option:

  ```ts
  import Stripe from 'stripe';
  import { HttpsProxyAgent } from 'https-proxy-agent';

  StripePlugin.init({
      // ...
      httpClient: Stripe.createNodeHttpClient(
          new HttpsProxyAgent(process.env.HTTPS_PROXY!),
      ),
  });
  ```

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
