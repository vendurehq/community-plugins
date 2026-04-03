# Vendure Elasticsearch Plugin

This plugin allows your product search to be powered by [Elasticsearch](https://github.com/elastic/elasticsearch) — a powerful open source search
engine. This is a drop-in replacement for the DefaultSearchPlugin which exposes many powerful configuration options enabling your storefront
to support a wide range of use-cases such as indexing of custom properties, fine control over search index configuration, and to leverage
advanced Elasticsearch features like spacial search.

## Version Requirements

**ElasticSearch v9.1.0 is supported**

The version of ElasticSearch that is deployed, the version of the JS library @elastic/elasticsearch installed in your Vendure project and the version
of the JS library @elastic/elasticsearch used in the @vendure/elasticsearch-plugin must all match to avoid any issues. ElasticSearch does not allow @latest
in its repository so these versions must be updated regularly.

| Package  | Version |
| ------------- | ------------- |
| ElasticSearch  | v9.1.0  |
| @elastic/elasticsearch  | v9.1.0  |
| @vendure/elasticsearch-plugin | v3.5.0  |
| Last updated | Dec 2, 2025 |

With ElasticSearch v8+, basic authentication, SSL, and TLS are enabled by default and may result in your client and plugin not being able to connect to
ElasticSearch successfully if your client is not configured appropriately. You must also set `xpack.license.self_generated.type=basic` if you are
using the free Community Edition of ElasticSearch.

Review the ElasticSearch docker [example](https://github.com/vendure-ecommerce/vendure/blob/master/docker-compose.yml) here for development
and testing without authentication and security enabled. Refer to ElasticSearch documentation to enable authentication and security in production.

## Installation

```shell
npm install @elastic/elasticsearch @vendure/elasticsearch-plugin
```

Make sure to remove the `DefaultSearchPlugin` if it is still in the VendureConfig plugins array.

## Setup

Then add the `ElasticsearchPlugin`, calling the `.init()` method with `ElasticsearchOptions`:

```ts
import { ElasticsearchPlugin } from '@vendure/elasticsearch-plugin';

const config: VendureConfig = {
  // Add an instance of the plugin to the plugins array
  plugins: [
    ElasticsearchPlugin.init({
      host: 'http://localhost',
      port: 9200,
    }),
  ],
};
```

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
