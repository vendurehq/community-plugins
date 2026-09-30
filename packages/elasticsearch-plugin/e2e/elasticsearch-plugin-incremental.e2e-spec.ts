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

// This suite opts in to incrementalIndexUpdates, so an update writes only what changed and never
// deletes-then-recreates. The default suite (elasticsearch-plugin.e2e-spec.ts) runs with the flag
// off and continues to cover the historic behaviour.
const INDEX_PREFIX = `e2e-incremental-tests-${searchBackend as string}-`;

describe(`Elasticsearch plugin incrementalIndexUpdates [${searchBackend as string}]`, () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [
                ElasticsearchPlugin.init({
                    indexPrefix: INDEX_PREFIX,
                    adapter: buildAdapterForBackend(),
                    incrementalIndexUpdates: true,
                }),
                DefaultJobQueuePlugin,
            ],
        }),
    );

    const rawAdapter = buildAdapterForBackend()();
    let variantId: string; // GraphQL id, for admin mutations
    let variantSku: string; // correlates to the indexed document (raw id, so we key by sku)

    // Read the variant's indexed document directly (by sku, since the GraphQL id is encoded but the
    // index stores the raw id), so assertions are exact and independent of search paging.
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
        await adminClient.query(updateProductVariantsDocument, {
            input: [{ id: variantId, trackInventory: GlobalFlag.TRUE, stockOnHand: 50 }],
        });
        await awaitRunningJobs(adminClient);
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    it('does not rewrite the document when an update produces no change', async () => {
        const before = await indexedVariantDoc();
        expect(before).toBeDefined();
        // Re-apply the identical values: the update-variants job runs, but the freshly built
        // document is identical to what is indexed, so nothing should be written.
        await adminClient.query(updateProductVariantsDocument, {
            input: [{ id: variantId, trackInventory: GlobalFlag.TRUE, stockOnHand: 50 }],
        });
        await awaitRunningJobs(adminClient);
        const after = await indexedVariantDoc();
        // A write (delete-then-recreate or replace) would bump the document version.
        expect(after!.version).toBe(before!.version);
        expect(after!.source.inStock).toBe(true);
    });

    it('writes the document when a real change occurs', async () => {
        const before = await indexedVariantDoc();
        await adminClient.query(updateProductVariantsDocument, {
            input: [{ id: variantId, price: 999_99 }],
        });
        await awaitRunningJobs(adminClient);
        const after = await indexedVariantDoc();
        expect(after!.version).toBeGreaterThan(before!.version);
        expect(after!.source.price).toBe(999_99);
    });

    it('reflects a stock movement that flips the variant out of stock', async () => {
        await adminClient.query(updateProductVariantsDocument, {
            input: [{ id: variantId, trackInventory: GlobalFlag.TRUE, stockOnHand: 0 }],
        });
        await awaitRunningJobs(adminClient);
        expect((await indexedVariantDoc())!.source.inStock).toBe(false);
    });

    it('reflects a stock movement that flips the variant back in stock', async () => {
        await adminClient.query(updateProductVariantsDocument, {
            input: [{ id: variantId, trackInventory: GlobalFlag.TRUE, stockOnHand: 50 }],
        });
        await awaitRunningJobs(adminClient);
        expect((await indexedVariantDoc())!.source.inStock).toBe(true);
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
