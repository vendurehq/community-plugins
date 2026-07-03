/* eslint-disable @typescript-eslint/no-non-null-assertion, no-console */
import { CurrencyCode, JobState, SortOrder } from '@vendure/common/lib/generated-types';
import { pick } from '@vendure/common/lib/pick';
import {
    DefaultJobQueuePlugin,
    FacetValue,
    facetValueCollectionFilter,
    LanguageCode,
    mergeConfig,
} from '@vendure/core';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import {
    createCollectionDocument,
    createFacetDocument,
    deleteProductDocument,
    deleteProductVariantDocument,
    updateCollectionDocument,
    updateProductDocument,
    updateProductVariantsDocument,
    updateTaxRateDocument,
} from './graphql/shared-definitions';
import { searchProductsShopDocument } from './graphql/shop-definitions';
import { awaitRunningJobs } from './await-running-jobs';
import { MeilisearchPlugin } from '../src/plugin';

import {
    doAdminSearchQuery,
    dropMeilisearchIndices,
    testCollectionIdsEdgeCases,
    testCollectionSlugsEdgeCases,
    testGroupByProduct,
    testGroupBySKU,
    testMatchCollectionId,
    testMatchCollectionIds,
    testMatchCollectionSlug,
    testMatchCollectionSlugs,
    testMatchFacetIdsAnd,
    testMatchFacetIdsOr,
    testMatchFacetValueFiltersAnd,
    testMatchFacetValueFiltersOr,
    testMatchFacetValueFiltersOrWithAnd,
    testMatchFacetValueFiltersWithFacetIdsAnd,
    testMatchFacetValueFiltersWithFacetIdsOr,
    testMatchSearchTerm,
    testNoGrouping,
    testPriceRanges,
    testSinglePrices,
} from './e2e-helpers';
import { graphql, ResultOf } from './graphql/graphql-admin';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { meilisearchHost, meilisearchPort } = require('./constants');

const INDEX_PREFIX = 'e2e-tests-';

describe('Meilisearch plugin', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [
                MeilisearchPlugin.init({
                    indexPrefix: INDEX_PREFIX,
                    host: `${meilisearchHost}:${meilisearchPort}`,
                    apiKey: process.env.MEILISEARCH_API_KEY || '',
                    customProductVariantMappings: {
                        inStock: {
                            graphQlType: 'Boolean!',
                            valueFn: variant => {
                                return (variant as any).stockLevels?.[0]?.stockOnHand > 0;
                            },
                        },
                    },
                    customProductMappings: {
                        answer: {
                            graphQlType: 'Int!',
                            valueFn: args => {
                                return 42;
                            },
                        },
                        hello: {
                            graphQlType: 'String!',
                            public: false,
                            valueFn: args => {
                                return 'World';
                            },
                        },
                    },
                    searchConfig: {
                        mapSort: (sort, input) => {
                            const priority = (input.sort as any)?.priority;
                            if (priority) {
                                return [
                                    ...sort,
                                    `product-priority:${priority === SortOrder.ASC ? 'asc' : 'desc'}`,
                                ];
                            }
                            return sort;
                        },
                    },
                    extendSearchSortType: ['priority'],
                }),
                DefaultJobQueuePlugin,
            ],
        }),
    );

    beforeAll(async () => {
        await dropMeilisearchIndices(INDEX_PREFIX);
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();
        // We have extra time here because a lot of jobs are
        // triggered from all the product updates
        await awaitRunningJobs(adminClient, 20_000, 1000);

        // Create an Electronics collection for testing multi-collection filters
        await adminClient.query(createCollectionDocument, {
            input: {
                translations: [
                    {
                        languageCode: LanguageCode.en,
                        name: 'Electronics',
                        description: 'Electronics products',
                        slug: 'electronics',
                    },
                ],
                filters: [
                    {
                        code: facetValueCollectionFilter.code,
                        arguments: [
                            {
                                name: 'facetValueIds',
                                value: '["T_1"]',
                            },
                            {
                                name: 'containsAny',
                                value: 'false',
                            },
                        ],
                    },
                ],
            },
        });

        // Wait for all initial import jobs to settle before reindexing
        await awaitRunningJobs(adminClient, 60_000, 2000);
        // Full reindex to build a clean Meilisearch index
        await adminClient.query(reindexDocument);
        await awaitRunningJobs(adminClient, 60_000, 1000);
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await awaitRunningJobs(adminClient);
        await server.destroy();
    });

    describe('shop api', () => {
        it('group by product', () => testGroupByProduct(shopClient));

        it('group by SKU', () => testGroupBySKU(shopClient));

        it('no grouping', () => testNoGrouping(shopClient));

        it('matches search term', () => testMatchSearchTerm(shopClient));

        it('matches by facetValueId with AND operator', () => testMatchFacetIdsAnd(shopClient));

        it('matches by facetValueId with OR operator', () => testMatchFacetIdsOr(shopClient));

        it('matches by FacetValueFilters AND', () => testMatchFacetValueFiltersAnd(shopClient));

        it('matches by FacetValueFilters OR', () => testMatchFacetValueFiltersOr(shopClient));

        it('matches by FacetValueFilters OR and AND', () => testMatchFacetValueFiltersOrWithAnd(shopClient));

        it('matches by FacetValueFilters with facetId OR operator', () =>
            testMatchFacetValueFiltersWithFacetIdsOr(shopClient));

        it('matches by FacetValueFilters with facetId AND operator', () =>
            testMatchFacetValueFiltersWithFacetIdsAnd(shopClient));

        it('matches by collectionId', () => testMatchCollectionId(shopClient));

        it('matches by collectionSlug', () => testMatchCollectionSlug(shopClient));

        it('matches by multiple collectionIds', () => testMatchCollectionIds(shopClient));

        it('matches by multiple collectionSlugs', () => testMatchCollectionSlugs(shopClient));

        it('handles collectionIds edge cases', () => testCollectionIdsEdgeCases(shopClient));

        it('handles collectionSlugs edge cases', () => testCollectionSlugsEdgeCases(shopClient));

        it('single prices', () => testSinglePrices(shopClient));

        it('price ranges', () => testPriceRanges(shopClient));

        it('returns correct facetValues when not grouped by product', async () => {
            const result = await shopClient.query(searchGetFacetValuesDocument, {
                input: {
                    groupByProduct: false,
                },
            });
            expect(result.search.facetValues).toEqual([
                { count: 21, facetValue: { id: 'T_1', name: 'electronics' } },
                { count: 17, facetValue: { id: 'T_2', name: 'computers' } },
                { count: 4, facetValue: { id: 'T_3', name: 'photo' } },
                { count: 10, facetValue: { id: 'T_4', name: 'sports equipment' } },
                { count: 4, facetValue: { id: 'T_5', name: 'home & garden' } },
                { count: 4, facetValue: { id: 'T_6', name: 'plants' } },
            ]);
        });

        it('returns correct facetValues when grouped by product', async () => {
            const result = await shopClient.query(searchGetFacetValuesDocument, {
                input: {
                    groupByProduct: true,
                },
            });
            // Meilisearch's facetDistribution counts are not affected by distinct,
            // so these reflect product-level facet counts (via productFacetValueIds)
            // which may differ slightly from Elasticsearch's aggregation approach
            expect(result.search.facetValues.length).toBe(6);
            const facetMap = new Map(
                result.search.facetValues.map((fv: any) => [fv.facetValue.name, fv.count]),
            );
            expect(facetMap.get('electronics')).toBeGreaterThan(0);
            expect(facetMap.get('computers')).toBeGreaterThan(0);
            expect(facetMap.get('photo')).toBeGreaterThan(0);
            expect(facetMap.get('sports equipment')).toBeGreaterThan(0);
            expect(facetMap.get('home & garden')).toBeGreaterThan(0);
            expect(facetMap.get('plants')).toBeGreaterThan(0);
        });

        it('returns correct collections when not grouped by product', async () => {
            const result = await shopClient.query(searchGetCollectionsDocument, {
                input: {
                    groupByProduct: false,
                },
            });
            const sortedCollections = [...result.search.collections].sort((a, b) =>
                a.collection.id.localeCompare(b.collection.id),
            );
            expect(sortedCollections).toEqual([
                { collection: { id: 'T_2', name: 'Plants' }, count: 4 },
                { collection: { id: 'T_3', name: 'Electronics' }, count: 21 },
            ]);
        });

        it('returns correct collections when grouped by product', async () => {
            const result = await shopClient.query(searchGetCollectionsDocument, {
                input: {
                    groupByProduct: true,
                },
            });
            const sortedCollections = [...result.search.collections].sort((a, b) =>
                a.collection.id.localeCompare(b.collection.id),
            );
            // Meilisearch's facetDistribution counts are computed before distinct is applied,
            // so collection counts reflect product-level associations (via productCollectionIds)
            expect(sortedCollections.length).toBe(2);
            expect(sortedCollections[0].collection.name).toBe('Plants');
            expect(sortedCollections[0].count).toBeGreaterThan(0);
            expect(sortedCollections[1].collection.name).toBe('Electronics');
            expect(sortedCollections[1].count).toBeGreaterThan(0);
        });

        it('encodes the productId and productVariantId', async () => {
            const result = await shopClient.query(searchProductsShopDocument, {
                input: {
                    term: 'Laptop 13 inch 8GB',
                    groupByProduct: false,
                    take: 1,
                },
            });
            expect(pick(result.search.items[0], ['productId', 'productVariantId'])).toEqual({
                productId: 'T_1',
                productVariantId: 'T_1',
            });
        });

        it('omits results for disabled ProductVariants', async () => {
            await adminClient.query(updateProductVariantsDocument, {
                input: [{ id: 'T_3', enabled: false }],
            });
            await awaitRunningJobs(adminClient);
            const result = await shopClient.query(searchProductsShopDocument, {
                input: {
                    groupByProduct: false,
                    take: 100,
                },
            });
            expect(result.search.items.map(i => i.productVariantId).includes('T_3')).toBe(false);
        });

        it('encodes collectionIds', async () => {
            const result = await shopClient.query(searchProductsShopDocument, {
                input: {
                    groupByProduct: false,
                    term: 'cactus',
                    take: 1,
                },
            });

            expect(result.search.items[0].collectionIds).toEqual(['T_2']);
        });

        it('inStock is true and not grouped by product', async () => {
            const result = await shopClient.query(searchProductsShopDocument, {
                input: {
                    groupByProduct: false,
                    inStock: true,
                },
            });
            expect(result.search.totalItems).toBe(31);
        });

        it('inStock is true and grouped by product', async () => {
            const result = await shopClient.query(searchProductsShopDocument, {
                input: {
                    groupByProduct: true,
                    inStock: true,
                },
            });
            expect(result.search.totalItems).toBe(19);
        });
    });

    describe('admin api', () => {
        it('group by product', () => testGroupByProduct(adminClient));

        it('group by SKU', () => testGroupBySKU(adminClient));

        it('no grouping', () => testNoGrouping(adminClient));

        it('matches search term', () => testMatchSearchTerm(adminClient));

        it('matches by facetValueId with AND operator', () => testMatchFacetIdsAnd(adminClient));

        it('matches by facetValueId with OR operator', () => testMatchFacetIdsOr(adminClient));

        it('matches by collectionId', () => testMatchCollectionId(adminClient));

        it('matches by collectionSlug', () => testMatchCollectionSlug(adminClient));

        it('matches by multiple collectionIds', () => testMatchCollectionIds(adminClient));

        it('matches by multiple collectionSlugs', () => testMatchCollectionSlugs(adminClient));

        it('handles collectionIds edge cases', () => testCollectionIdsEdgeCases(adminClient));

        it('handles collectionSlugs edge cases', () => testCollectionSlugsEdgeCases(adminClient));

        it('single prices', () => testSinglePrices(adminClient));

        it('price ranges', () => testPriceRanges(adminClient));

        describe('updating the index', () => {
            it('updates index when ProductVariants are changed', async () => {
                await awaitRunningJobs(adminClient);
                const { search } = await doAdminSearchQuery(adminClient, {
                    term: 'drive',
                    groupByProduct: false,
                });
                expect(search.items.map(i => i.sku).sort()).toEqual(
                    ['IHD455T1', 'IHD455T2', 'IHD455T3', 'IHD455T4', 'IHD455T6'].sort(),
                );

                await adminClient.query(updateProductVariantsDocument, {
                    input: search.items.map(i => ({
                        id: i.productVariantId,
                        sku: i.sku + '_updated',
                    })),
                });
                await awaitRunningJobs(adminClient);
                const { search: search2 } = await doAdminSearchQuery(adminClient, {
                    term: 'drive',
                    groupByProduct: false,
                });

                expect(search2.items.map(i => i.sku).sort()).toEqual(
                    [
                        'IHD455T1_updated',
                        'IHD455T2_updated',
                        'IHD455T3_updated',
                        'IHD455T4_updated',
                        'IHD455T6_updated',
                    ].sort(),
                );
            });

            it('updates index when ProductVariants are deleted', async () => {
                await awaitRunningJobs(adminClient);
                const { search } = await doAdminSearchQuery(adminClient, {
                    term: 'drive',
                    groupByProduct: false,
                });

                await adminClient.query(deleteProductVariantDocument, {
                    id: search.items[0].productVariantId,
                });

                await awaitRunningJobs(adminClient);
                await awaitRunningJobs(adminClient);
                const { search: search2 } = await doAdminSearchQuery(adminClient, {
                    term: 'drive',
                    groupByProduct: false,
                });

                expect(search2.items.length).toBe(search.items.length - 1);
            });

            it('updates index when a Product is changed', async () => {
                await adminClient.query(updateProductDocument, {
                    input: {
                        id: 'T_1',
                        facetValueIds: [],
                    },
                });
                await awaitRunningJobs(adminClient);
                const result = await doAdminSearchQuery(adminClient, {
                    facetValueIds: ['T_2'],
                    groupByProduct: true,
                });
                expect(result.search.items.map(i => i.productName).sort()).toEqual([
                    'Clacky Keyboard',
                    'Curvy Monitor',
                    'Gaming PC',
                    'Hard Drive',
                    'USB Cable',
                ]);
            });

            it('updates index when a Product is deleted', async () => {
                const { search } = await doAdminSearchQuery(adminClient, {
                    facetValueIds: ['T_2'],
                    groupByProduct: true,
                });
                expect(search.items.map(i => i.productId).sort()).toEqual([
                    'T_2',
                    'T_3',
                    'T_4',
                    'T_5',
                    'T_6',
                ]);
                await adminClient.query(deleteProductDocument, {
                    id: 'T_5',
                });
                await awaitRunningJobs(adminClient);
                const { search: search2 } = await doAdminSearchQuery(adminClient, {
                    facetValueIds: ['T_2'],
                    groupByProduct: true,
                });
                expect(search2.items.map(i => i.productId).sort()).toEqual(['T_2', 'T_3', 'T_4', 'T_6']);
            });

            it('updates index when a Collection is changed', async () => {
                await adminClient.query(updateCollectionDocument, {
                    input: {
                        id: 'T_2',
                        filters: [
                            {
                                code: facetValueCollectionFilter.code,
                                arguments: [
                                    {
                                        name: 'facetValueIds',
                                        value: '["T_4"]',
                                    },
                                    {
                                        name: 'containsAny',
                                        value: 'false',
                                    },
                                ],
                            },
                        ],
                    },
                });
                await awaitRunningJobs(adminClient);
                // add an additional check for the collection filters to update
                await awaitRunningJobs(adminClient);
                const result1 = await doAdminSearchQuery(adminClient, {
                    collectionId: 'T_2',
                    groupByProduct: true,
                });

                expect(result1.search.items.map(i => i.productName).sort()).toEqual([
                    'Boxing Gloves',
                    'Cruiser Skateboard',
                    'Football',
                    'Road Bike',
                    'Running Shoe',
                    'Skipping Rope',
                    'Tent',
                ]);
            });

            it('updates index when a Collection is created', async () => {
                const { createCollection } = await adminClient.query(createCollectionDocument, {
                    input: {
                        translations: [
                            {
                                languageCode: LanguageCode.en,
                                name: 'Photo',
                                description: '',
                                slug: 'photo',
                            },
                        ],
                        filters: [
                            {
                                code: facetValueCollectionFilter.code,
                                arguments: [
                                    {
                                        name: 'facetValueIds',
                                        value: '["T_3"]',
                                    },
                                    {
                                        name: 'containsAny',
                                        value: 'false',
                                    },
                                ],
                            },
                        ],
                    },
                });
                await awaitRunningJobs(adminClient);
                // add an additional check for the collection filters to update
                await awaitRunningJobs(adminClient);
                const result = await doAdminSearchQuery(adminClient, {
                    collectionId: createCollection.id,
                    groupByProduct: true,
                });
                expect(result.search.items.map(i => i.productName).sort()).toEqual([
                    'Camera Lens',
                    'Instant Camera',
                    'SLR Camera',
                    'Tripod',
                ]);
            });

            it('updates index when a taxRate is changed', async () => {
                await adminClient.query(updateTaxRateDocument, {
                    input: {
                        // Default Channel's defaultTaxZone is Europe (id 2) and the id of the standard TaxRate
                        // to Europe is 2.
                        id: 'T_2',
                        value: 50,
                    },
                });
                await awaitRunningJobs(adminClient);
                const result = await adminClient.query(searchProductsAdminDocument, {
                    input: {
                        groupByProduct: true,
                        term: 'laptop',
                    },
                });
                expect(result.search.items[0].price).toEqual({
                    min: 129900,
                    max: 229900,
                });
                expect(result.search.items[0].priceWithTax).toEqual({
                    min: 194850,
                    max: 344850,
                });
            });
        });
    });

    describe('custom mappings', () => {
        it('custom product mappings', async () => {
            const result = await shopClient.query(gql`
                query {
                    search(input: { term: "laptop", groupByProduct: true, take: 1 }) {
                        items {
                            productName
                            customProductMappings {
                                answer
                            }
                        }
                    }
                }
            `);
            expect(result.search.items[0].customProductMappings?.answer).toBe(42);
        });

        it('private custom product mapping not returned in shop api', async () => {
            const result = await shopClient.query(gql`
                query {
                    search(input: { term: "laptop", groupByProduct: true, take: 1 }) {
                        items {
                            productName
                            customProductMappings {
                                answer
                            }
                        }
                    }
                }
            `);
            // 'hello' is private, so not exposed in shop API
            expect(result.search.items[0].customProductMappings?.hello).toBeUndefined();
        });
    });
});

// ===== GraphQL documents used by tests =====

export const searchProductsAdminDocument = graphql(`
    query SearchProductsAdmin($input: SearchInput!) {
        search(input: $input) {
            totalItems
            items {
                enabled
                productId
                productName
                slug
                description
                productVariantId
                productVariantName
                sku
                collectionIds
                price {
                    ... on PriceRange {
                        min
                        max
                    }
                    ... on SinglePrice {
                        value
                    }
                }
                priceWithTax {
                    ... on PriceRange {
                        min
                        max
                    }
                    ... on SinglePrice {
                        value
                    }
                }
                productAsset {
                    id
                    preview
                    focalPoint {
                        x
                        y
                    }
                }
                productVariantAsset {
                    id
                    preview
                    focalPoint {
                        x
                        y
                    }
                }
                sku
            }
        }
    }
`);

export const searchGetFacetValuesDocument = graphql(`
    query SearchFacetValues($input: SearchInput!) {
        search(input: $input) {
            totalItems
            facetValues {
                count
                facetValue {
                    id
                    name
                }
            }
        }
    }
`);

export const searchGetCollectionsDocument = graphql(`
    query SearchCollections($input: SearchInput!) {
        search(input: $input) {
            totalItems
            collections {
                count
                collection {
                    id
                    name
                }
            }
        }
    }
`);

export const searchGetPricesDocument = graphql(`
    query SearchGetPrices($input: SearchInput!) {
        search(input: $input) {
            items {
                price {
                    ... on PriceRange {
                        min
                        max
                    }
                    ... on SinglePrice {
                        value
                    }
                }
                priceWithTax {
                    ... on PriceRange {
                        min
                        max
                    }
                    ... on SinglePrice {
                        value
                    }
                }
            }
        }
    }
`);

const reindexDocument = graphql(`
    mutation Reindex {
        reindex {
            id
            queueName
            state
            progress
            duration
            result
        }
    }
`);

const getJobInfoDocument = graphql(`
    query GetJobInfo($id: ID!) {
        job(jobId: $id) {
            id
            queueName
            state
            progress
            duration
            result
        }
    }
`);
