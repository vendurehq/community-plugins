# Migration from `@vendure/*`

These packages were extracted from the main [vendurehq/vendure](https://github.com/vendurehq/vendure) monorepo. To migrate, update your package imports:

```diff
- import { ElasticsearchPlugin } from '@vendure/elasticsearch-plugin';
+ import { ElasticsearchPlugin } from '@vendure-community/elasticsearch-plugin';

- import { StripePlugin } from '@vendure/payments-plugin/package/stripe';
+ import { StripePlugin } from '@vendure-community/stripe-plugin';

- import { MolliePlugin } from '@vendure/payments-plugin/package/mollie';
+ import { MolliePlugin } from '@vendure-community/mollie-plugin';

- import { BraintreePlugin } from '@vendure/payments-plugin/package/braintree';
+ import { BraintreePlugin } from '@vendure-community/braintree-plugin';

- import { SentryPlugin } from '@vendure/sentry-plugin';
+ import { SentryPlugin } from '@vendure-community/sentry-plugin';

- import { StellatePlugin } from '@vendure/stellate-plugin';
+ import { StellatePlugin } from '@vendure-community/stellate-plugin';

- import { PubSubPlugin } from '@vendure/job-queue-plugin/package/pub-sub';
+ import { PubSubPlugin } from '@vendure-community/pub-sub-plugin';
```
