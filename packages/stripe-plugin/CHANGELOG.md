# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## 2.0.0 (2026-11-09)

Moves the plugin onto the current Stripe SDK (`stripe@23`) and the `endive` API release.

### Breaking changes

- **`stripe` peer dependency: `13.x` → `^23.0.0`.** Upgrade `stripe` in your project together with
  the plugin. `stripe@23` requires Node.js 20 or later.
- **The default Stripe API version is now the one pinned by the installed `stripe` package.** For
  `stripe@23.0.x` this is `2026-09-30.endive`. Later `stripe@23` minor releases can pin a newer
  `endive` version; Stripe only makes breaking changes when the release name changes, so these
  updates add fields without changing existing ones.

  Before 2.0.0 the plugin passed `apiVersion: null`, intending the Stripe account's default API
  version to apply. The SDK has always replaced `null` with its own pinned version (on v13 and
  since), so 1.x already used the SDK's pinned version, `2023-08-16`. The SDK cannot be told to
  omit the version, so the account default is still not used.

  To keep a fixed version across `stripe` upgrades, or to stay on an older version while you
  migrate, set the new `apiVersion` option:

  ```ts
  import type { StripeLatestApiVersion } from '@vendure-community/stripe-plugin';

  StripePlugin.init({
      // ...
      apiVersion: '2023-08-16' as StripeLatestApiVersion,
  });
  ```

  The SDK's TypeScript types describe the pinned version, so with an older version the types no
  longer match the responses exactly. The fields this plugin reads are the same in both.
- **`payment_method_types` is no longer accepted on PaymentIntents.** The `endive` API removes it
  in favour of `allowed_payment_method_types`. The plugin itself sends
  `automatic_payment_methods: { enabled: true }` and is not affected. If your
  `paymentIntentCreateParams` function returns `payment_method_types`, TypeScript now reports an
  error; return `allowed_payment_method_types` instead.

### Unchanged

- **Webhook signing secret.** The secret remains the `webhookSecret` argument on each Stripe
  payment method, so each channel verifies webhooks with its own secret. There is no plugin-level
  `webhookSecret` option, in 1.x or 2.0.0.
- **HTTP transport.** Requests still go through the SDK's Node client (`node:http`/`node:https`).

### Features

- **`encryptSecrets` option.** On Vendure 3.8 or later, set `encryptSecrets: true` to store the
  `apiKey` and `webhookSecret` arguments encrypted, using the `encryptionStrategy` from your
  `systemOptions`. Credentials stay in plain text by default, so existing installations and older
  Vendure versions are unaffected. Values which are already stored stay in plain text until a new
  value is saved, so enter both credentials again after enabling the option. See the README.
- **`apiVersion` option**, described above.
- **`httpClient` option.** Pass `Stripe.createNodeHttpClient(agent)` to route requests through a
  proxy or tune keep-alive, or `Stripe.createFetchHttpClient()` to use `globalThis.fetch`:

  ```ts
  import Stripe from 'stripe';
  import { HttpsProxyAgent } from 'https-proxy-agent';

  StripePlugin.init({
      // ...
      httpClient: Stripe.createNodeHttpClient(new HttpsProxyAgent(process.env.HTTPS_PROXY!)),
  });
  ```

- **Refund `reason` is forwarded.** When the Vendure refund `reason` is one of Stripe's values
  (`duplicate`, `fraudulent`, `requested_by_customer`), it is sent as the refund's `reason`. Any
  other reason is stored in the refund's metadata as `vendureRefundReason`.

### Development

- `nock` 13 → 14, `rimraf` 5 → 6.

## 1.1.0 (2026-10-28)

### Features

* **stripe-plugin:** add opt-in manual capture (authorize then capture) ([#58](https://github.com/vendurehq/community-plugins/pull/58))

### Bug Fixes

* **stripe-plugin:** tolerate webhook events whose object has no metadata ([#62](https://github.com/vendurehq/community-plugins/pull/62))
* **stripe-plugin:** verify webhook signature before order lookup ([#60](https://github.com/vendurehq/community-plugins/pull/60))
* **stripe-plugin:** pass requestOptions to customer list/create calls ([#38](https://github.com/vendurehq/community-plugins/pull/38))

## 1.0.0 (2026-03-30)

Initial release as `@vendure-community/stripe-plugin`, extracted from `@vendure/payments-plugin`.
Equivalent to the functionality in Vendure core v3.5.6.

No additional feature changes from the v3.6.0 development branch.
