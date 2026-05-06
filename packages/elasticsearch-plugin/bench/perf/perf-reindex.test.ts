import { JobState } from '@vendure/common/lib/generated-types';
import { DefaultJobQueuePlugin, mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import * as fs from 'fs';
import gql from 'graphql-tag';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../../e2e-common/test-config';
import { ElasticsearchPlugin } from '../../src/plugin';

import { awaitRunningJobs } from '../../e2e/await-running-jobs';
import { buildAdapterForBackend } from '../../e2e/build-adapter-for-backend';
import { deleteIndices } from '../../src/indexing/indexing-utils';
import { diffSnapshots, snapshotIndex } from '../../e2e/snapshot-index';

async function dropElasticIndices(indexPrefix: string) {
    const adapter = buildAdapterForBackend()();
    try {
        await deleteIndices(adapter, indexPrefix);
    } finally {
        await adapter.close();
    }
}

const { searchBackend } = require('../../e2e/constants');

const LABEL = process.env.BENCH_LABEL || 'untitled';
const RUNS = Math.max(1, parseInt(process.env.PERF_RUNS || '5', 10));
const INDEX_PREFIX = `e2e-perf-${searchBackend as string}-`;
const BENCH_DIR = path.resolve(__dirname, '..');
const RESULT_PATH = path.join(BENCH_DIR, 'results', `${LABEL}.json`);
const SNAPSHOT_PATH = path.join(BENCH_DIR, 'snapshots', `${LABEL}.ndjson`);

const reindexMutation = gql`
    mutation Reindex {
        reindex {
            id
            state
            duration
            result
        }
    }
`;

describe(`Perf reindex bench [${LABEL}]`, () => {
    const { server, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [
                ElasticsearchPlugin.init({
                    indexPrefix: INDEX_PREFIX,
                    adapter: buildAdapterForBackend(),
                    reindexConcurrency: parseInt(process.env.PERF_CONCURRENCY || '8', 10),
                    reindexBulkConcurrency: parseInt(process.env.PERF_BULK_CONCURRENCY || '4', 10),
                }),
                DefaultJobQueuePlugin,
            ],
        }),
    );

    beforeAll(async () => {
        await dropElasticIndices(INDEX_PREFIX);
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, '..', '..', 'e2e', 'fixtures', 'e2e-products-full.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();
        await awaitRunningJobs(adminClient, 30_000, 1000);
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await awaitRunningJobs(adminClient);
        await server.destroy();
    }, TEST_SETUP_TIMEOUT_MS);

    it(`runs reindex x${RUNS} and records metrics`, async () => {
        const durations: number[] = [];
        const results: Array<{ run: number; durationMs: number }> = [];

        for (let i = 0; i < RUNS; i++) {
            const start = Date.now();
            await adminClient.query<{ reindex: { id: string } }>(reindexMutation);
            await awaitRunningJobs(adminClient, 600_000, 200);
            const wallclock = Date.now() - start;
            durations.push(wallclock);
            results.push({ run: i + 1, durationMs: wallclock });
        }

        const sorted = [...durations].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const mean = durations.reduce((a, b) => a + b, 0) / durations.length;

        const docCount = await snapshotIndex(`${INDEX_PREFIX}variants`, SNAPSHOT_PATH);

        const summary = {
            label: LABEL,
            backend: searchBackend,
            runs: RUNS,
            median_ms: median,
            min_ms: min,
            max_ms: max,
            mean_ms: Math.round(mean),
            durations_ms: durations,
            doc_count: docCount,
            snapshot_path: path.relative(process.cwd(), SNAPSHOT_PATH),
            recorded_at: new Date().toISOString(),
            details: results,
        };

        fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
        fs.writeFileSync(RESULT_PATH, JSON.stringify(summary, null, 2) + '\n');

        // eslint-disable-next-line no-console
        console.log(`\n[bench:${LABEL}] median=${median}ms mean=${Math.round(mean)}ms min=${min}ms max=${max}ms docs=${docCount}\n`);

        expect(durations.length).toBe(RUNS);
        expect(docCount).toBeGreaterThan(0);
    }, TEST_SETUP_TIMEOUT_MS);

    it('matches baseline snapshot if present', () => {
        const baseline = path.join(BENCH_DIR, 'snapshots', 'baseline.ndjson');
        if (LABEL === 'baseline' || !fs.existsSync(baseline)) {
            return;
        }
        const diff = diffSnapshots(baseline, SNAPSHOT_PATH);
        if (!diff.equal) {
            // eslint-disable-next-line no-console
            console.error(
                `[bench:${LABEL}] snapshot diverges from baseline: baseline=${diff.aLines} this=${diff.bLines} firstDiffIdx=${diff.firstDiffIndex}`,
            );
        }
        expect(diff.equal).toBe(true);
    });
});
