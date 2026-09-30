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
import { updateProductVariantsDocument } from './graphql/shared-definitions';
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
});

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
