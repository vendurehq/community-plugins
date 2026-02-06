# Vendure Community Plugins

[![Build & Test](https://github.com/vendurehq/community-plugins/actions/workflows/build-and-test.yml/badge.svg)](https://github.com/vendurehq/community-plugins/actions/workflows/build-and-test.yml)

Community-maintained plugins for the [Vendure](https://www.vendure.io/) e-commerce framework.

## Packages

| Package                                                                    | Description                                      | npm                                                                                                                                                   |
|----------------------------------------------------------------------------|--------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| [`@vendure-community/elasticsearch-plugin`](packages/elasticsearch-plugin) | Elasticsearch-based search for Vendure           | [![npm](https://img.shields.io/npm/v/@vendure-community/elasticsearch-plugin)](https://www.npmjs.com/package/@vendure-community/elasticsearch-plugin) |
| [`@vendure-community/payments-plugin`](packages/payments-plugin)           | Payment integrations (Stripe, Mollie, Braintree) | [![npm](https://img.shields.io/npm/v/@vendure-community/payments-plugin)](https://www.npmjs.com/package/@vendure-community/payments-plugin)           |
| [`@vendure-community/sentry-plugin`](packages/sentry-plugin)               | Sentry error tracking integration                | [![npm](https://img.shields.io/npm/v/@vendure-community/sentry-plugin)](https://www.npmjs.com/package/@vendure-community/sentry-plugin)               |
| [`@vendure-community/stellate-plugin`](packages/stellate-plugin)           | Stellate CDN cache purging                       | [![npm](https://img.shields.io/npm/v/@vendure-community/stellate-plugin)](https://www.npmjs.com/package/@vendure-community/stellate-plugin)           |
| [`@vendure-community/pub-sub-plugin`](packages/pub-sub-plugin)             | Google Cloud Pub/Sub job queue strategy          | [![npm](https://img.shields.io/npm/v/@vendure-community/pub-sub-plugin)](https://www.npmjs.com/package/@vendure-community/pub-sub-plugin)             |

## Migration from `@vendure/*`

These packages were extracted from the main [vendurehq/vendure](https://github.com/vendurehq/vendure) monorepo. To migrate, update your package imports:

```diff
- import { ElasticsearchPlugin } from '@vendure/elasticsearch-plugin';
+ import { ElasticsearchPlugin } from '@vendure-community/elasticsearch-plugin';

- import { StripePlugin } from '@vendure/payments-plugin/package/stripe';
+ import { StripePlugin } from '@vendure-community/payments-plugin/package/stripe';

- import { SentryPlugin } from '@vendure/sentry-plugin';
+ import { SentryPlugin } from '@vendure-community/sentry-plugin';

- import { StellatePlugin } from '@vendure/stellate-plugin';
+ import { StellatePlugin } from '@vendure-community/stellate-plugin';

- import { PubSubPlugin } from '@vendure/job-queue-plugin/package/pub-sub';
+ import { PubSubPlugin } from '@vendure-community/pub-sub-plugin';
```

## Development

### Prerequisites

- Node.js >= 20
- Docker (for Elasticsearch and Redis in e2e tests)

### Setup

```bash
npm install
npm run build
```

### Linting

```bash
# Check for lint issues
npm run lint

# Auto-fix lint issues
npx eslint --fix .
```

### Running tests

```bash
# Start services
docker compose up -d

# Run all unit tests
npm run test

# Run all e2e tests
npm run e2e

# Run e2e for a specific package
cd packages/elasticsearch-plugin && npm run e2e
```

## License

GPL-3.0-or-later. See [LICENSE.md](LICENSE.md).
