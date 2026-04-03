import { DocumentNode } from 'graphql';
import { gql } from 'graphql-tag';

import { MeilisearchOptions } from '../options';

export function generateSchemaExtensions(options: MeilisearchOptions): DocumentNode {
    const customMappingTypes = generateCustomMappingTypes(options);
    const inputExtensions = Object.entries(options.extendSearchInputType || {});
    const sortExtensions = options.extendSearchSortType || [];
    const aiEnabled = !!(options.ai?.embedders && Object.keys(options.ai.embedders).length > 0);

    const sortExtensionGql = `
    extend input SearchResultSortParameter {
        ${sortExtensions.map(key => `${key}: SortOrder`).join('\n            ')}
    }`;

    const similarDocumentsGql = aiEnabled
        ? `
        """
        Input for finding similar documents using AI embeddings.
        Requires AI search to be configured in the MeilisearchPlugin.
        """
        input SimilarDocumentsInput {
            "The document ID to find similar documents for (format: channelId_variantId_languageCode)"
            id: String!
            "The embedder to use. Defaults to the configured default embedder."
            embedder: String
            "Maximum number of results. Defaults to 10."
            limit: Int
            "Number of results to skip. Defaults to 0."
            offset: Int
            "Optional Meilisearch filter string to narrow results."
            filter: String
        }

        type SimilarDocumentsResponse {
            items: [SearchResult!]!
            totalItems: Int!
        }

        extend type Query {
            "Find products similar to a given document. Requires AI search to be configured."
            similarDocuments(input: SimilarDocumentsInput!): SimilarDocumentsResponse!
        }
    `
        : '';

    return gql`
        extend type SearchResponse {
            prices: SearchResponsePriceData!
        }

        extend type SearchResult {
            inStock: Boolean
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
            groupBySKU: Boolean
            ${inputExtensions.map(([name, type]) => `${name}: ${type}`).join('\n            ')}
        }

        ${sortExtensions.length > 0 ? sortExtensionGql : ''}

        input PriceRangeInput {
            min: Int!
            max: Int!
        }

        ${customMappingTypes ? customMappingTypes : ''}

        ${similarDocumentsGql}
    `;
}

function generateCustomMappingTypes(options: MeilisearchOptions): DocumentNode | undefined {
    const productMappings = Object.entries(options.customProductMappings || {}).filter(
        ([, value]) => value.public ?? true,
    );
    const variantMappings = Object.entries(options.customProductVariantMappings || {}).filter(
        ([, value]) => value.public ?? true,
    );
    let sdl = '';

    if (productMappings.length || variantMappings.length) {
        if (productMappings.length) {
            sdl += `
            type CustomProductMappings {
                ${productMappings.map(([name, def]) => `${name}: ${def.graphQlType}`).join('\n')}
            }
            `;
        }
        if (variantMappings.length) {
            sdl += `
            type CustomProductVariantMappings {
                ${variantMappings.map(([name, def]) => `${name}: ${def.graphQlType}`).join('\n')}
            }
            `;
        }
        if (productMappings.length && variantMappings.length) {
            sdl += `
                union CustomMappings = CustomProductMappings | CustomProductVariantMappings

                extend type SearchResult {
                    customMappings: CustomMappings! @deprecated(reason: "Use customProductMappings or customProductVariantMappings")
                    customProductMappings: CustomProductMappings!
                    customProductVariantMappings: CustomProductVariantMappings!
                }
            `;
        } else if (productMappings.length) {
            sdl += `
                extend type SearchResult {
                    customMappings: CustomProductMappings! @deprecated(reason: "Use customProductMappings or customProductVariantMappings")
                    customProductMappings: CustomProductMappings!
                }
            `;
        } else if (variantMappings.length) {
            sdl += `
                extend type SearchResult {
                    customMappings: CustomProductVariantMappings! @deprecated(reason: "Use customProductMappings or customProductVariantMappings")
                    customProductVariantMappings: CustomProductVariantMappings!
                }
            `;
        }
    }
    return sdl.length
        ? gql`
              ${sdl}
          `
        : undefined;
}
