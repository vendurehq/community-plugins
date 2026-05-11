import { DocumentNode } from 'graphql';
import { gql } from 'graphql-tag';

import { MeilisearchOptions } from '../options';

export function generateSchemaExtensions(options: MeilisearchOptions): DocumentNode {
    const customMappingTypes = generateCustomMappingTypes(options);
    const inputExtensions = Object.entries(options.extendSearchInputType || {});
    const sortExtensions = options.extendSearchSortType || [];

    const sortExtensionGql = `
    extend input SearchResultSortParameter {
        ${sortExtensions.map(key => `${key}: SortOrder`).join('\n            ')}
    }`;

    return gql`
        extend type SearchResponse {
            prices: SearchResponsePriceData!
        }

        extend type SearchResult {
            inStock: Boolean
            formattedProductName: String
            formattedDescription: String
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
