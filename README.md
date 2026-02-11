<p align="center">
  <a href="https://vendure.io">
    <img alt="Vendure logo" height="60" width="auto" src="https://a.storyblok.com/f/328257/699x480/8dbb4c7a3c/logo-icon.png">
  </a>
</p>

<h1 align="center">
  Vendure Community Plugins
</h1>
<h3 align="center">
  Community-first plugins for the Vendure e-commerce framework
</h3>
<h4 align="center">
  <a href="https://docs.vendure.io">Documentation</a> |
  <a href="https://vendure.io">Website</a> |
  <a href="https://vendure.io/community">Discord</a>
</h4>

<p align="center">
  <a href="https://github.com/vendurehq/community-plugins/blob/main/LICENSE.md">
    <img src="https://img.shields.io/badge/license-GPL-blue.svg" alt="GPL license" />
  </a>
  <a href="https://github.com/vendurehq/community-plugins/actions/workflows/build-and-test.yml">
    <img src="https://github.com/vendurehq/community-plugins/actions/workflows/build-and-test.yml/badge.svg" alt="Build & Test" />
  </a>
  <a href="https://github.com/vendurehq/community-plugins/blob/main/CONTRIBUTING.md">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat" alt="PRs welcome!" />
  </a>
</p>

## Packages

| Package                                                                    | Description                                      | npm                                                                                                                                                   |
|----------------------------------------------------------------------------|--------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| [`@vendure-community/elasticsearch-plugin`](packages/elasticsearch-plugin) | Elasticsearch-based search for Vendure           | [![npm](https://img.shields.io/npm/v/@vendure-community/elasticsearch-plugin)](https://www.npmjs.com/package/@vendure-community/elasticsearch-plugin) |
| [`@vendure-community/payments-plugin`](packages/payments-plugin)           | Payment integrations (Stripe, Mollie, Braintree) | [![npm](https://img.shields.io/npm/v/@vendure-community/payments-plugin)](https://www.npmjs.com/package/@vendure-community/payments-plugin)           |
| [`@vendure-community/sentry-plugin`](packages/sentry-plugin)              | Sentry error tracking integration                | [![npm](https://img.shields.io/npm/v/@vendure-community/sentry-plugin)](https://www.npmjs.com/package/@vendure-community/sentry-plugin)               |
| [`@vendure-community/stellate-plugin`](packages/stellate-plugin)          | Stellate CDN cache purging                       | [![npm](https://img.shields.io/npm/v/@vendure-community/stellate-plugin)](https://www.npmjs.com/package/@vendure-community/stellate-plugin)           |
| [`@vendure-community/pub-sub-plugin`](packages/pub-sub-plugin)            | Google Cloud Pub/Sub job queue strategy          | [![npm](https://img.shields.io/npm/v/@vendure-community/pub-sub-plugin)](https://www.npmjs.com/package/@vendure-community/pub-sub-plugin)             |

## Community Ownership

These plugins are **community-first** — the Vendure core team provides support and infrastructure, but day-to-day ownership sits with dedicated maintainers. Each plugin ideally has one dedicated maintainer or maintainer group (e.g. an agency) who drives development, reviews PRs, and handles releases.

**Want to maintain a plugin?** Reach out at [contact@vendure.io](mailto:contact@vendure.io?subject=Community%20Plugin%20Maintainer%20Interest).

## Migration from `@vendure/*`

These packages were extracted from the main [vendurehq/vendure](https://github.com/vendurehq/vendure) monorepo. If you're migrating from the original `@vendure/*` packages, see the full [Migration Guide](MIGRATION.md).

## Contributing

We welcome contributions from the community. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, testing, and the release process.

## License

GPL-3.0-or-later. See [LICENSE.md](LICENSE.md).
