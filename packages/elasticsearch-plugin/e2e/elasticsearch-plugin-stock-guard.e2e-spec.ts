/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { GlobalFlag, SortOrder } from '@vendure/common/lib/generated-types';
import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { VARIANT_INDEX_NAME } from '../src/constants';
import { ElasticsearchPlugin } from '../src/plugin';

import { awaitRunningJobs } from './await-running-jobs';
import { buildAdapterForBackend } from './build-adapter-for-backend';
import { graphql } from './graphql/graphql-admin';
import { getRunningJobsDocument, updateProductVariantsDocument } from './graphql/shared-definitions';
import { searchProductsShopDocument } from './graphql/shop-definitions';

const { searchBackend } = require('./constants');

// No custom mappings here, and reindexOnStockMovement is 'onStockStatusChange', so the pre-enqueue
// stock guard is active. This is where a stock change that does not flip inStock should create no
// job at all, for both order-driven movements and admin stock-only variant updates.
const INDEX_PREFIX = `e2e-stockguard-tests-${searchBackend as string}-`;

describe(`Elasticsearch plugin stock guard [${searchBackend as string}]`, () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [
                ElasticsearchPlugin.init({
                    indexPrefix: INDEX_PREFIX,
                    adapter: buildAdapterForBackend(),
                    reindexOnStockMovement: 'onStockStatusChange',
                }),
                DefaultJobQueuePlugin,
            ],
        }),
    );

    const rawAdapter = buildAdapterForBackend()();
    let variantId: string; // GraphQL id, for admin mutations
    let variantSku: string; // correlates to the indexed document (raw id, so we key by sku)

    async function indexedVariantDoc(): Promise<{ source: any; version: number } | undefined> {
        await rawAdapter.indices.refresh({ index: INDEX_PREFIX + VARIANT_INDEX_NAME });
        const result = await rawAdapter.search({
            index: INDEX_PREFIX + VARIANT_INDEX_NAME,
            body: { query: { term: { 'sku.keyword': variantSku } }, version: true } as any,
        });
        const hit = (result.body.hits.hits as any[])[0];
        return hit ? { source: hit._source, version: hit._version } : undefined;
    }

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();
        await awaitRunningJobs(adminClient, 10_000, 1000);
        await adminClient.query(reindexDocument);
        await awaitRunningJobs(adminClient);

        const result = await shopClient.query(searchProductsShopDocument, {
            input: { groupByProduct: false, inStock: true, sort: { name: SortOrder.ASC } },
        });
        const item = result.search.items[0];
        expect(item).toBeDefined();
        variantId = item.productVariantId;
        variantSku = item.sku;

        // Track inventory with a known in-stock quantity so the cases below are deterministic.
        await adminClient.query(updateProductVariantsDocument, {
            input: [{ id: variantId, trackInventory: GlobalFlag.TRUE, stockOnHand: 50 }],
        });
        await awaitRunningJobs(adminClient);
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    it('does not reindex an admin stock change that does not flip inStock', async () => {
        const before = await indexedVariantDoc();
        expect(before).toBeDefined();
        expect(before!.source.inStock).toBe(true);
        // Still in stock afterwards, so the guard should skip the job entirely (no write).
        await adminClient.query(updateProductVariantsDocument, {
            input: [{ id: variantId, trackInventory: GlobalFlag.TRUE, stockOnHand: 40 }],
        });
        await awaitRunningJobs(adminClient);
        const after = await indexedVariantDoc();
        expect(after!.version).toBe(before!.version);
        expect(after!.source.inStock).toBe(true);
    });

    it('reindexes an admin stock change that flips inStock out of stock', async () => {
        const before = await indexedVariantDoc();
        await adminClient.query(updateProductVariantsDocument, {
            input: [{ id: variantId, trackInventory: GlobalFlag.TRUE, stockOnHand: 0 }],
        });
        await awaitRunningJobs(adminClient);
        const after = await indexedVariantDoc();
        expect(after!.version).toBeGreaterThan(before!.version);
        expect(after!.source.inStock).toBe(false);
    });

    it('reindexes an admin stock change that flips inStock back in stock', async () => {
        await adminClient.query(updateProductVariantsDocument, {
            input: [{ id: variantId, trackInventory: GlobalFlag.TRUE, stockOnHand: 25 }],
        });
        await awaitRunningJobs(adminClient);
        expect((await indexedVariantDoc())!.source.inStock).toBe(true);
    });

    it('reindexes a non-stock change even under onStockStatusChange', async () => {
        const before = await indexedVariantDoc();
        await adminClient.query(updateProductVariantsDocument, {
            input: [{ id: variantId, price: 777_77 }],
        });
        await awaitRunningJobs(adminClient);
        const after = await indexedVariantDoc();
        expect(after!.version).toBeGreaterThan(before!.version);
        expect(after!.source.price).toBe(777_77);
    });

    // Order-driven StockMovementEvents (allocations). The guard only looks at the moved variant
    // (see vendurehq/community-plugins#51), so a sale that leaves it in stock must create no job,
    // and a sale that sells it out must reindex and flip both inStock and productInStock.
    describe('order allocations', () => {
        let lensVariantId: string;
        let lensSku: string;
        let lensProductId: string;

        async function indexedDocBySku(sku: string): Promise<{ source: any; version: number } | undefined> {
            await rawAdapter.indices.refresh({ index: INDEX_PREFIX + VARIANT_INDEX_NAME });
            const result = await rawAdapter.search({
                index: INDEX_PREFIX + VARIANT_INDEX_NAME,
                body: { query: { term: { 'sku.keyword': sku } }, version: true } as any,
            });
            const hit = (result.body.hits.hits as any[])[0];
            return hit ? { source: hit._source, version: hit._version } : undefined;
        }

        async function searchIndexJobCount(): Promise<number> {
            const { jobs } = await adminClient.query(getRunningJobsDocument, {
                options: { filter: { queueName: { eq: 'update-search-index' } } },
            });
            return jobs.totalItems;
        }

        async function placeOrder(productVariantId: string, quantity: number) {
            const { createDraftOrder } = await adminClient.query(createDraftOrderDocument);
            const orderId = createDraftOrder.id;
            await adminClient.query(setCustomerForDraftOrderDocument, {
                orderId,
                input: {
                    firstName: 'Stock',
                    lastName: 'Guard',
                    emailAddress: `stock-guard-${orderId}@example.com`,
                },
            });
            await adminClient.query(addItemToDraftOrderDocument, {
                orderId,
                input: { productVariantId, quantity },
            });
            await adminClient.query(setDraftOrderShippingAddressDocument, {
                orderId,
                input: { streetLine1: '1 Test Street', countryCode: 'GB' },
            });
            const { eligibleShippingMethodsForDraftOrder } = await adminClient.query(
                eligibleShippingMethodsForDraftOrderDocument,
                { orderId },
            );
            await adminClient.query(setDraftOrderShippingMethodDocument, {
                orderId,
                shippingMethodId: eligibleShippingMethodsForDraftOrder[0].id,
            });
            const { transitionOrderToState } = await adminClient.query(transitionOrderToStateDocument, {
                id: orderId,
                state: 'ArrangingPayment',
            });
            expect((transitionOrderToState as any).state).toBe('ArrangingPayment');
            // A settled payment moves the order to PaymentSettled, which allocates stock and
            // publishes a StockMovementEvent for the variant.
            const { addManualPaymentToOrder } = await adminClient.query(addManualPaymentToOrderDocument, {
                input: { orderId, method: 'manual', transactionId: `txn-${orderId}`, metadata: {} },
            });
            expect((addManualPaymentToOrder as any).state).toBe('PaymentSettled');
        }

        beforeAll(async () => {
            const { product } = await adminClient.query(getProductBySlugDocument, { slug: 'camera-lens' });
            // A single-variant product, so selling the variant out also flips productInStock.
            expect(product!.variants).toHaveLength(1);
            lensVariantId = product!.variants[0].id;
            lensSku = product!.variants[0].sku;
            lensProductId = product!.id;
            await adminClient.query(updateProductVariantsDocument, {
                input: [{ id: lensVariantId, trackInventory: GlobalFlag.TRUE, stockOnHand: 50 }],
            });
            await awaitRunningJobs(adminClient);
            const doc = await indexedDocBySku(lensSku);
            expect(doc!.source.inStock).toBe(true);
            expect(doc!.source.productInStock).toBe(true);
        }, TEST_SETUP_TIMEOUT_MS);

        it('creates no job for an allocation that leaves the variant in stock (50 to 49)', async () => {
            const jobsBefore = await searchIndexJobCount();
            const before = await indexedDocBySku(lensSku);
            await placeOrder(lensVariantId, 1);
            await awaitRunningJobs(adminClient);
            // The sale really allocated stock, so a StockMovementEvent reached the guard.
            const { productVariant } = await adminClient.query(getVariantStockDocument, {
                id: lensVariantId,
            });
            expect(productVariant!.stockAllocated).toBe(1);
            expect(await searchIndexJobCount()).toBe(jobsBefore);
            const after = await indexedDocBySku(lensSku);
            expect(after!.version).toBe(before!.version);
            expect(after!.source.inStock).toBe(true);
            expect(after!.source.productInStock).toBe(true);
        });

        it('reindexes when an allocation sells the variant out', async () => {
            // 49 saleable now; drop to 2 saleable (no flip, so still no job), then sell both.
            await adminClient.query(updateProductVariantsDocument, {
                input: [{ id: lensVariantId, trackInventory: GlobalFlag.TRUE, stockOnHand: 3 }],
            });
            await awaitRunningJobs(adminClient);
            const jobsBefore = await searchIndexJobCount();
            const before = await indexedDocBySku(lensSku);
            expect(before!.source.inStock).toBe(true);

            await placeOrder(lensVariantId, 2);
            await awaitRunningJobs(adminClient);

            expect(await searchIndexJobCount()).toBeGreaterThan(jobsBefore);
            const after = await indexedDocBySku(lensSku);
            expect(after!.source.inStock).toBe(false);
            expect(after!.source.productInStock).toBe(false);

            const variantSearch = await shopClient.query(searchProductsShopDocument, {
                input: { groupByProduct: false, inStock: false, take: 100 },
            });
            expect(variantSearch.search.items.map(i => i.sku)).toContain(lensSku);
            const productSearch = await shopClient.query(searchProductsShopDocument, {
                input: { groupByProduct: true, inStock: false, take: 100 },
            });
            expect(productSearch.search.items.map(i => i.productId)).toContain(lensProductId);
        });
    });
});

const getProductBySlugDocument = graphql(`
    query GetProductBySlugForStockGuard($slug: String!) {
        product(slug: $slug) {
            id
            variants {
                id
                sku
            }
        }
    }
`);

const getVariantStockDocument = graphql(`
    query GetVariantStockForStockGuard($id: ID!) {
        productVariant(id: $id) {
            id
            stockAllocated
        }
    }
`);

const createDraftOrderDocument = graphql(`
    mutation CreateDraftOrderForStockGuard {
        createDraftOrder {
            id
        }
    }
`);

const setCustomerForDraftOrderDocument = graphql(`
    mutation SetCustomerForDraftOrderForStockGuard($orderId: ID!, $input: CreateCustomerInput) {
        setCustomerForDraftOrder(orderId: $orderId, input: $input) {
            ... on Order {
                id
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`);

const addItemToDraftOrderDocument = graphql(`
    mutation AddItemToDraftOrderForStockGuard($orderId: ID!, $input: AddItemToDraftOrderInput!) {
        addItemToDraftOrder(orderId: $orderId, input: $input) {
            ... on Order {
                id
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`);

const setDraftOrderShippingAddressDocument = graphql(`
    mutation SetDraftOrderShippingAddressForStockGuard($orderId: ID!, $input: CreateAddressInput!) {
        setDraftOrderShippingAddress(orderId: $orderId, input: $input) {
            id
        }
    }
`);

const eligibleShippingMethodsForDraftOrderDocument = graphql(`
    query EligibleShippingMethodsForDraftOrderForStockGuard($orderId: ID!) {
        eligibleShippingMethodsForDraftOrder(orderId: $orderId) {
            id
        }
    }
`);

const setDraftOrderShippingMethodDocument = graphql(`
    mutation SetDraftOrderShippingMethodForStockGuard($orderId: ID!, $shippingMethodId: ID!) {
        setDraftOrderShippingMethod(orderId: $orderId, shippingMethodId: $shippingMethodId) {
            ... on Order {
                id
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`);

const transitionOrderToStateDocument = graphql(`
    mutation TransitionOrderToStateForStockGuard($id: ID!, $state: String!) {
        transitionOrderToState(id: $id, state: $state) {
            ... on Order {
                id
                state
            }
            ... on OrderStateTransitionError {
                errorCode
                message
                transitionError
            }
        }
    }
`);

const addManualPaymentToOrderDocument = graphql(`
    mutation AddManualPaymentToOrderForStockGuard($input: ManualPaymentInput!) {
        addManualPaymentToOrder(input: $input) {
            ... on Order {
                id
                state
            }
            ... on ErrorResult {
                errorCode
                message
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
