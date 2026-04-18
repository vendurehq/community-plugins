# Vendure OpenSearch Plugin

This plugin allows your product search to be powered by [OpenSearch](https://opensearch.org/) — an open source,
community-driven search engine forked from Elasticsearch 7.10. It is a drop-in replacement for the
`DefaultSearchPlugin` (and a near-drop-in replacement for `@vendure-community/elasticsearch-plugin`) that exposes
many powerful configuration options enabling your storefront to support a wide range of use-cases such as indexing
of custom properties, fine control over search index configuration, and to leverage advanced OpenSearch features
like cross-cluster replication (CCR), spatial search, and the OpenSearch query DSL.

## Why OpenSearch?

OpenSearch is API-compatible with Elasticsearch 7.10 and continues to gain features like cross-cluster replication
(CCR), Lucene 10 (in 3.x), Java 21 runtime, and significant performance improvements on aggregation-heavy workloads
(important for this plugin, which uses cardinality and term aggregations for facet/collection counts and
price-range buckets).

## Version Requirements

**OpenSearch 2.19+ and 3.x are supported.**

The version of OpenSearch that is deployed and the version of the JS library `@opensearch-project/opensearch`
installed in your Vendure project should be aligned to avoid any compatibility issues.

| Package                                  | Version           |
| ---------------------------------------- | ----------------- |
| OpenSearch                               | 2.19+ / 3.x       |
| @opensearch-project/opensearch           | ^3.5.1            |
| @vendure-community/opensearch-plugin     | 0.1.0             |
| Last updated                             | 2026-04           |

By default the OpenSearch security plugin is enabled in distributions of OpenSearch and will require you to use
HTTPS and basic authentication. For local development you can disable security with the
`DISABLE_SECURITY_PLUGIN=true` environment variable on the OpenSearch image; the example `docker-compose.yml` in
this repo is configured this way.

Refer to the [OpenSearch security documentation](https://opensearch.org/docs/latest/security/) to enable
authentication and TLS in production.

## Installation

```shell
npm install @opensearch-project/opensearch @vendure-community/opensearch-plugin
```

Make sure to remove the `DefaultSearchPlugin` (or any other previously-installed search plugin) from the
VendureConfig `plugins` array.

## Setup

Add the `OpenSearchPlugin`, calling the `.init()` method with `OpenSearchOptions`:

```ts
import { OpenSearchPlugin } from '@vendure-community/opensearch-plugin';

const config: VendureConfig = {
  plugins: [
    OpenSearchPlugin.init({
      host: 'http://localhost',
      port: 9200,
    }),
  ],
};
```

### Migrating from `@vendure-community/elasticsearch-plugin`

The plugin is intentionally API-compatible with `@vendure-community/elasticsearch-plugin`. To migrate:

1. `npm uninstall @vendure-community/elasticsearch-plugin @elastic/elasticsearch`
2. `npm install @vendure-community/opensearch-plugin @opensearch-project/opensearch`
3. In your `vendure-config.ts`, change the import and class name:

   ```diff
   - import { ElasticsearchPlugin } from '@vendure-community/elasticsearch-plugin';
   + import { OpenSearchPlugin } from '@vendure-community/opensearch-plugin';

     plugins: [
   -   ElasticsearchPlugin.init({ /* ... */ }),
   +   OpenSearchPlugin.init({ /* ... */ }),
     ],
   ```

The option fields (`host`, `port`, `clientOptions`, `searchConfig`, `indexPrefix`,
`extendSearchInputType`, `customProductMappings`, `customProductVariantMappings`,
`customProductScriptMappings`, `customProductVariantScriptMappings`, `bufferUpdates`,
`hydrateProductRelations`, `hydrateProductVariantRelations`, `route`) all keep the same names
and semantics. The GraphQL schema extensions (`SearchResponsePriceData`, `PriceRangeBucket`,
`PriceRangeInput`, etc.) are unchanged so storefront queries continue to work without changes.

## Cross-Cluster Replication (CCR)

OpenSearch supports cross-cluster replication, which lets a follower cluster mirror an indexed
leader cluster. This plugin uses an alias-swap strategy during reindex (it reindexes into a new
physical index, then atomically swaps the alias). Note that **aliases are not automatically
replicated to follower clusters**: when reindexing in a CCR setup you must coordinate the alias
swap on each follower (typically by re-running the OpenSearch
`POST _aliases` action against follower clusters or by using OpenSearch's replication-rules
feature). The indexed documents themselves replicate automatically.

## Search API Extensions

This plugin extends the default search query of the Shop API, allowing richer querying of your product data.

The `SearchResponse` type is extended with information about price ranges in the result set:

```graphql
extend type SearchResponse {
    prices: SearchResponsePriceData!
}

type SearchResponsePriceData {
    range: PriceRange!
    rangeWithTax: PriceRange!
    buckets: [PriceRangeBucket!]!
    bucketsWithTax: [PriceRangeBucket!]!
}

type PriceRangeBucket {
    to: Int!
    count: Int!
}

extend input SearchInput {
    priceRange: PriceRangeInput
    priceRangeWithTax: PriceRangeInput
    inStock: Boolean
}

input PriceRangeInput {
    min: Int!
    max: Int!
}
```

This `SearchResponsePriceData` type allows you to query data about the range of prices in the result set.

## Example Request & Response

```graphql
{
  search (input: {
    term: "table easel"
    groupByProduct: true
    priceRange: {
      min: 500
      max: 7000
    }
  }) {
    totalItems
    prices {
      range {
        min
        max
      }
      buckets {
        to
        count
      }
    }
    items {
      productName
      score
      price {
        ...on PriceRange {
          min
          max
        }
      }
    }
  }
}
```

```json
{
  "data": {
    "search": {
      "totalItems": 9,
      "prices": {
        "range": {
          "min": 999,
          "max": 6396
        },
        "buckets": [
          { "to": 1000, "count": 1 },
          { "to": 2000, "count": 2 },
          { "to": 3000, "count": 3 },
          { "to": 4000, "count": 1 },
          { "to": 5000, "count": 1 },
          { "to": 7000, "count": 1 }
        ]
      },
      "items": [
        {
          "productName": "Loxley Yorkshire Table Easel",
          "score": 30.58831,
          "price": { "min": 4984, "max": 4984 }
        }
      ]
    }
  }
}
```
