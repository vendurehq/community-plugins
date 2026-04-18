# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## 0.1.0

Initial release as `@vendure-community/opensearch-plugin`.

The plugin is a port of `@vendure-community/elasticsearch-plugin` (v1.1.0) that targets the
[OpenSearch](https://opensearch.org/) project instead of Elasticsearch. The public API surface
(option shape, GraphQL schema extensions, indexed document shape) is identical to the
Elasticsearch plugin, so swapping `ElasticsearchPlugin` for `OpenSearchPlugin` in a Vendure
config should require no other changes.

### Features

* Built against the official `@opensearch-project/opensearch` JavaScript client v3.5.x.
* Verified against OpenSearch 2.19+ and 3.x server versions.
* Same indexing, search, faceting, price-bucketing, custom-mapping and custom-script-field
  features as the upstream Elasticsearch plugin.
