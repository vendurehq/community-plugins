import { JobState } from '@vendure/common/lib/generated-types';
import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { deleteIndices } from '../src/indexing/indexing-utils';
import { ElasticsearchPlugin } from '../src/plugin';

import { awaitRunningJobs } from './await-running-jobs';
import { buildAdapterForBackend } from './build-adapter-for-backend';
import { graphql } from './graphql/graphql-admin';
import { searchProductsShopDocument } from './graphql/shop-definitions';


const { searchBackend } = require('./constants');

// Own prefix so this spec's indices never collide with the other spec files'
// (which run in the same vitest worker, sequentially, against the same
// Elasticsearch/OpenSearch instance).
const INDEX_PREFIX = `e2e-bulk-errors-${searchBackend as string}-`;

// Product ids whose `poison` custom mapping should be forced to a non-numeric
// value, so the explicit `integer` field mapping below makes the backend
// reject the bulk item with a *parsing_exception. Module-level because the
// plugin config (and its `valueFn` closures) is built once, at import time,
// while individual tests mutate this set to poison/un-poison product 5.
const poisoned = new Set<string>();

describe(`Elasticsearch plugin bulk errors [${searchBackend as string}]`, () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [
                ElasticsearchPlugin.init({
                    indexPrefix: INDEX_PREFIX,
                    adapter: buildAdapterForBackend(),
                    indexMappingProperties: { 'product-poison': { type: 'integer' } },
                    customProductMappings: {
                        poison: {
                            graphQlType: 'Int!',
                            valueFn: product =>
                                poisoned.has(String(product.id)) ? ('not-a-number' as any) : 1,
                        },
                    },
                }),
                DefaultJobQueuePlugin,
            ],
        }),
    );

    beforeAll(async () => {
        // Delete the index currently behind this spec's live alias, if any,
        // left over from a previous run, before the plugin creates fresh ones.
        const cleanupAdapter = buildAdapterForBackend()();
        try {
            await deleteIndices(cleanupAdapter, INDEX_PREFIX);
        } finally {
            await cleanupAdapter.close();
        }

        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();
        // Extra time here because a lot of jobs are triggered from all the
        // product imports.
        await awaitRunningJobs(adminClient, 10_000, 1000);

        // Establish a clean, fully-indexed baseline before any test pollutes
        // it by poisoning a product.
        await adminClient.query(reindexDocument);
        await awaitRunningJobs(adminClient);
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    /**
     * Asserts that exactly one index carries the live `${INDEX_PREFIX}variants`
     * alias, and that no alias name still references an in-progress/abandoned
     * reindex (`-reindex-` in the name).
     */
    async function assertSingleCleanAlias() {
        const adapter = buildAdapterForBackend()();
        let body: Record<string, { aliases: Record<string, unknown> }>;
        try {
            ({ body } = await adapter.indices.getAlias({ index: `${INDEX_PREFIX}variants*` }));
        } finally {
            await adapter.close();
        }

        const targetAlias = `${INDEX_PREFIX}variants`;
        const aliasEntries = Object.values(body) as Array<{ aliases: Record<string, unknown> }>;
        const allAliasNames = aliasEntries.flatMap(entry => Object.keys(entry.aliases));
        const indicesCarryingTargetAlias = aliasEntries.filter(entry =>
            Object.keys(entry.aliases).includes(targetAlias),
        );

        expect(indicesCarryingTargetAlias.length).toBe(1);
        expect(allAliasNames.some(aliasName => aliasName.includes('-reindex-'))).toBe(false);
    }

    it('sanity: after init + reindex, shop search returns 21 products and the alias check passes', async () => {
        const { search } = await shopClient.query(searchProductsShopDocument, {
            input: { groupByProduct: true },
        });
        expect(search.totalItems).toBe(21);

        await assertSingleCleanAlias();
    });

    it('a poisoned product fails the reindex job and leaves the live index untouched', async () => {
        poisoned.add('5');

        const { reindex } = await adminClient.query(reindexDocument);
        await awaitRunningJobs(adminClient);

        const { job } = await adminClient.query(getJobDocument, { id: reindex.id });

        expect(job?.state).toBe(JobState.FAILED);
        const errorMessage = String(job?.error);
        expect(errorMessage).toMatch(/1 of \d+ items errored/);
        expect(errorMessage).toMatch(/parsing_exception/);

        // The failed reindex must not have swapped the live alias onto a
        // half-written temp index.
        await assertSingleCleanAlias();

        const { search } = await shopClient.query(searchProductsShopDocument, {
            input: { groupByProduct: true },
        });
        expect(search.totalItems).toBe(21);
    }, 30_000);

    it('a poisoned product fails the update-product job', async () => {
        // Product 5 ('5') is still poisoned from the previous test.
        //
        // All job types (reindex, update-product, update-variants, ...) run
        // through the same single `update-search-index` queue, so the
        // preceding test's own FAILED reindex job is still sitting on this
        // queue at this point. Read the FAILED job ids on this queue as a
        // baseline *before* triggering `updateProduct`, then diff against
        // that baseline afterwards so the assertion is tied to the job this
        // test itself causes, not a residual job from the previous test.
        const failedIndexJobsFilter = {
            queueName: { eq: 'update-search-index' },
            state: { eq: JobState.FAILED },
        };
        const { jobs: baselineJobs } = await adminClient.query(getFailedIndexJobsDocument, {
            options: { filter: failedIndexJobsFilter },
        });
        const baselineJobIds = new Set(baselineJobs.items.map(item => item.id));

        await adminClient.query(updateProductDocument, {
            input: { id: 'T_5', enabled: true },
        });
        await awaitRunningJobs(adminClient);

        const { jobs } = await adminClient.query(getFailedIndexJobsDocument, {
            options: { filter: failedIndexJobsFilter },
        });
        const newFailedJobs = jobs.items.filter(item => !baselineJobIds.has(item.id));

        expect(newFailedJobs.length).toBeGreaterThanOrEqual(1);
        expect(newFailedJobs.some(item => /parsing_exception/.test(String(item.error)))).toBe(true);
    });

    it('clearing the poison recovers the index on the next reindex', async () => {
        poisoned.clear();

        const { reindex } = await adminClient.query(reindexDocument);
        await awaitRunningJobs(adminClient);

        const { job } = await adminClient.query(getJobDocument, { id: reindex.id });
        expect(job?.state).toBe(JobState.COMPLETED);

        await assertSingleCleanAlias();

        const { search } = await shopClient.query(searchProductsShopDocument, {
            input: { groupByProduct: true },
        });
        expect(search.totalItems).toBe(21);

        // customProductMappings.poison isn't part of the static gql.tada schema
        // snapshot (it only exists because THIS spec's plugin config defines
        // it), so it has to be queried with an untyped document rather than
        // through `graphql()`. Same approach as the "customMappings" describe
        // block in elasticsearch-plugin.e2e-spec.ts around line 1272.
        const { search: poisonSearch } = await shopClient.query(gql(poisonSearchQuery), {
            input: { groupByProduct: true, term: 'Clacky' },
        });
        expect(poisonSearch.items[0]?.customProductMappings?.poison).toBe(1);
    }, 30_000);
});

const reindexDocument = graphql(`
    mutation ReindexForBulkErrorsTest {
        reindex {
            id
            state
        }
    }
`);

const getJobDocument = graphql(`
    query GetJobForBulkErrorsTest($id: ID!) {
        job(jobId: $id) {
            id
            state
            error
        }
    }
`);

const getFailedIndexJobsDocument = graphql(`
    query GetFailedIndexJobsForBulkErrorsTest($options: JobListOptions) {
        jobs(options: $options) {
            items {
                id
                state
                error
            }
            totalItems
        }
    }
`);

const updateProductDocument = graphql(`
    mutation UpdateProductForBulkErrorsTest($input: UpdateProductInput!) {
        updateProduct(input: $input) {
            id
        }
    }
`);

const poisonSearchQuery = `
    query SearchPoisonForBulkErrorsTest($input: SearchInput!) {
        search(input: $input) {
            items {
                productId
                customProductMappings {
                    poison
                }
            }
        }
    }
`;
