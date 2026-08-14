import { describe, expect, it, vi } from 'vitest';

import { ElasticsearchIndexerController } from './indexer.controller';

describe('ElasticsearchIndexerController bulk operations', () => {
    it('rejects when Elasticsearch reports failed bulk items', async () => {
        const controller = Object.create(ElasticsearchIndexerController.prototype);
        controller.options = { indexPrefix: 'test-' };
        controller.adapter = {
            bulk: vi.fn().mockResolvedValue({
                body: {
                    took: 1,
                    errors: true,
                    items: [
                        {
                            update: {
                                error: { type: 'mapper_parsing_exception', reason: 'invalid price' },
                            },
                        },
                    ],
                },
            }),
        };

        await expect(
            controller.executeBulkOperationsByChunks(100, [
                {
                    index: 'variants',
                    operation: { update: { _id: '1' } },
                },
            ]),
        ).rejects.toThrow('Bulk operations failed on index [test-variants]');
    });
});
