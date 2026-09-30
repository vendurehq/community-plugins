# Vendure Elasticsearch / OpenSearch Plugin

This plugin allows your product search to be powered by either
[Elasticsearch](https://github.com/elastic/elasticsearch) or
[OpenSearch](https://github.com/opensearch-project/OpenSearch) — powerful open
source search engines. This is a drop-in replacement for the
`DefaultSearchPlugin` which exposes many powerful configuration options
enabling your storefront to support a wide range of use-cases such as indexing
of custom properties, fine control over search index configuration, and to
leverage advanced search features like spatial search.

The plugin exposes a **pluggable `SearchClientAdapter`** interface, so you pick
the backend by installing exactly one of the two client libraries and passing
the corresponding adapter.

## Version Requirements

Vendure v3.6+ requires Elasticsearch v9.1 or newer. When using OpenSearch, the
3.x client / 3.x server line is supported.

The version of the search engine that is deployed, the version of the
JavaScript client installed in your Vendure project and the version of that
same client used internally by `@vendure-community/elasticsearch-plugin` must
all match to avoid any issues. Neither client allows `@latest` in its public
repository, so these versions must be updated regularly.

| Package                                  | Minimum version |
| ---------------------------------------- | --------------- |
| `@vendure/core`                          | `3.6.0`         |
| `@vendure-community/elasticsearch-plugin`| `2.0.0`         |
| Elasticsearch (server + client)          | `9.1.0`         |
| OpenSearch (server + client)             | `3.0.0`         |

With Elasticsearch v8+, basic authentication, SSL, and TLS are enabled by
default and may result in your client and plugin not being able to connect to
Elasticsearch successfully if your client is not configured appropriately. You
must also set `xpack.license.self_generated.type=basic` if you are using the
free Community Edition of Elasticsearch.

Review the Elasticsearch docker
[example](https://github.com/vendure-ecommerce/vendure/blob/master/docker-compose.yml)
here for development and testing without authentication and security enabled.
Refer to the Elasticsearch documentation to enable authentication and security
in production.

## Installation

Install the plugin plus exactly **one** of the two search clients:

```shell
# Elasticsearch
npm install @vendure-community/elasticsearch-plugin @elastic/elasticsearch
```

```shell
# OpenSearch
npm install @vendure-community/elasticsearch-plugin @opensearch-project/opensearch
```

Both clients are declared as `optional` peer dependencies — only install the
one you use. Make sure to remove the `DefaultSearchPlugin` from your
`VendureConfig` plugins array.

## Setup

Build the adapter for the backend you want to use and pass it to
`ElasticsearchPlugin.init()`.

### Elasticsearch

```ts
import { ElasticsearchPlugin, createElasticsearchAdapter } from '@vendure-community/elasticsearch-plugin';

const config: VendureConfig = {
  plugins: [
    ElasticsearchPlugin.init({
      // `adapter` is a factory: the plugin invokes it once per internal
      // NestJS provider so each gets its own client / connection pool.
      adapter: () =>
        createElasticsearchAdapter({
          host: 'http://localhost',
          port: 9200,
          // Any additional @elastic/elasticsearch ClientOptions
          // (auth, tls, cloud, headers, etc.) may be provided via `clientOptions`.
          // clientOptions: { auth: { username: 'elastic', password: 'changeme' } },
        }),
      indexPrefix: 'vendure-',
    }),
  ],
};
```

### OpenSearch

```ts
import { ElasticsearchPlugin, createOpenSearchAdapter } from '@vendure-community/elasticsearch-plugin';

const config: VendureConfig = {
  plugins: [
    ElasticsearchPlugin.init({
      adapter: () =>
        createOpenSearchAdapter({
          host: 'http://localhost',
          port: 9200,
          // Any additional @opensearch-project/opensearch ClientOptions
          // (auth, ssl, awssigv4, headers, etc.) may be provided via `clientOptions`.
        }),
      indexPrefix: 'vendure-',
    }),
  ],
};
```

### Custom adapter

`SearchClientAdapter` is a public TypeScript interface. You can implement your
own adapter (e.g. to use a managed/hosted service with a custom SDK, or to
inject a test double) and pass it directly:

```ts
import { ElasticsearchPlugin, SearchClientAdapter } from '@vendure-community/elasticsearch-plugin';

class MyCustomAdapter implements SearchClientAdapter { /* ... */ }

ElasticsearchPlugin.init({
  // Return a fresh instance per call. The plugin invokes the factory once
  // per internal provider (the read-side service and the write-side indexer),
  // so each gets its own client and connection pool — bulk indexing cannot
  // saturate the pool serving live search queries, and shutdown closes them
  // independently.
  adapter: () => new MyCustomAdapter(),
});
```

If you need direct access to the underlying client (for example to issue a
query that is not on the `SearchClientAdapter` surface), each built-in adapter
exposes its native client via `adapter.getRawClient()`.

## Reducing reindex churn (opt-in)

By default the plugin re-indexes a product on every relevant event and writes by
deleting the product's documents and recreating them. Two opt-in options reduce
that work. Both default to the historic behaviour, so existing installs are
unaffected until you enable them.

```ts
ElasticsearchPlugin.init({
  adapter: () => createOpenSearchAdapter({ host, port }),
  // Skip the queue job for a stock change that cannot affect search results.
  reindexOnStockMovement: 'onStockStatusChange',
  // Write only what actually changed, in place, instead of delete-then-recreate.
  incrementalIndexUpdates: true,
});
```

### `incrementalIndexUpdates` (default `false`)

When enabled, an update reads the product's currently indexed documents, compares
them against the freshly built ones, and writes only the difference: it replaces
the documents that changed, creates new ones, deletes the ones that no longer
exist, and writes nothing when nothing changed. Because it never deletes a
still-current document first, the product does not briefly drop out of search
during an update. It compares the whole document, so it is correct for any mapping
configuration. A full `reindex` still writes every document, and a product too
large to diff safely falls back to the delete-then-recreate path.

### `reindexOnStockMovement` (default `'always'`)

Controls whether a stock change enqueues a re-index job. This covers both an
order-driven `StockMovementEvent` and an admin variant update that touched only
stock-level fields. With `'onStockStatusChange'` the plugin checks, before
creating a job, whether the change would flip a variant's `inStock` or its
product's `productInStock`, and skips the job when it would not, avoiding the
queue write, the poll wait and the worker cycle for a change that cannot affect
search results (for example a 50 to 49 change that leaves the item in stock).

The check inspects only the built-in stock booleans, so it applies only when
neither `customProductMappings` nor `customProductVariantMappings` is configured.
When either is set, a custom field could derive from stock and change without an
`inStock` flip, so the plugin automatically falls back to `'always'`. If you map a
stock-derived field, keep `'always'` and use `incrementalIndexUpdates`, which
compares the whole document and stays correct for any mapping.

## Migrating from v1.x

Versions prior to `2.0.0` shipped as `@vendure/elasticsearch-plugin` and
accepted `host` / `port` directly in `ElasticsearchPlugin.init(...)`. The
v2 release introduces the adapter pattern so the same plugin can power both
Elasticsearch and OpenSearch.

**Before (v1.x):**

```ts
ElasticsearchPlugin.init({
  host: 'http://localhost',
  port: 9200,
});
```

**After (v2.x):**

```ts
ElasticsearchPlugin.init({
  adapter: () =>
    createElasticsearchAdapter({
      host: 'http://localhost',
      port: 9200,
    }),
});
```

Note the arrow: `adapter` accepts a **factory** that produces a
`SearchClientAdapter`, not an adapter instance directly. The plugin calls
the factory once per internal provider so each owns its own client.

The `clientOptions` property that previously lived at the top level of
`ElasticsearchOptions` now lives on the adapter factory options and is passed
through to the underlying client constructor verbatim.

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
          {
            "to": 1000,
            "count": 1
          },
          {
            "to": 2000,
            "count": 2
          },
          {
            "to": 3000,
            "count": 3
          },
          {
            "to": 4000,
            "count": 1
          },
          {
            "to": 5000,
            "count": 1
          },
          {
            "to": 7000,
            "count": 1
          }
        ]
      },
      "items": [
        {
          "productName": "Loxley Yorkshire Table Easel",
          "score": 30.58831,
          "price": {
            "min": 4984,
            "max": 4984
          }
        }
        // ... truncated
      ]
    }
  }
}
```
