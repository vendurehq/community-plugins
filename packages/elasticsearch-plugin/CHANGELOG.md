# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## 2.0.0

### Features

* **elasticsearch-plugin:** introduce pluggable `SearchClientAdapter` interface so the plugin can be backed by either Elasticsearch or OpenSearch. Ship two first-party adapters: `ElasticsearchAdapter` (via `createElasticsearchAdapter`) and `OpenSearchAdapter` (via `createOpenSearchAdapter`). `@elastic/elasticsearch` and `@opensearch-project/opensearch` are both declared as optional peer dependencies — install only the one you use.
* **elasticsearch-plugin:** expose `adapter.getRawClient()` escape hatch for advanced queries that are not on the `SearchClientAdapter` surface.

### BREAKING CHANGES

* **elasticsearch-plugin:** `ElasticsearchPlugin.init({ host, port, clientOptions })` is replaced with `ElasticsearchPlugin.init({ adapter })`. Wrap existing configuration with `createElasticsearchAdapter({ host, port, clientOptions })` to preserve previous behaviour. See the README "Migrating from v1.x" section for a worked example.
* **elasticsearch-plugin:** bumps minimum Elasticsearch server/client to `9.1.0` to align with Vendure `3.6.0`'s [minimum Elasticsearch requirement](https://github.com/vendurehq/vendure/releases/tag/v3.6.0).

## 1.1.0

Changes synced from the Vendure core v3.6.0 development branch.

### Features

* **elasticsearch-plugin:** update to ElasticSearch v9.1.0 ([#3740](https://github.com/vendurehq/vendure/pull/3740))
* **elasticsearch-plugin:** add search by collection slugs or collection IDs ([#3182](https://github.com/vendurehq/vendure/pull/3182))
* **elasticsearch-plugin:** add collectionIds and collectionSlugs filters to e2e tests ([#3945](https://github.com/vendurehq/vendure/pull/3945))

### Bug Fixes

* **elasticsearch-plugin:** include channelId in productInStock cache key ([#4214](https://github.com/vendurehq/vendure/pull/4214))
* **elasticsearch-plugin:** deprecate built-in health check features ([#4442](https://github.com/vendurehq/vendure/pull/4442))
* **elasticsearch-plugin:** bump @elastic/elasticsearch to ^9.3.4 ([#4565](https://github.com/vendurehq/vendure/pull/4565))

## 1.0.0 (2026-02-06)

Initial release as `@vendure-community/elasticsearch-plugin`, extracted from `@vendure/elasticsearch-plugin`.
Equivalent to the functionality in Vendure core v3.5.6.
