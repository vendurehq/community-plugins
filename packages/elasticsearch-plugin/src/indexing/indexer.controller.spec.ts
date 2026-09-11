import { Logger } from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BulkOperationError } from './bulk-errors';
import { ElasticsearchIndexerController } from './indexer.controller';

describe('ElasticsearchIndexerController.executeBulkOperationsByChunks()', () => {
    let fakeAdapter: { bulk: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
    let controller: ElasticsearchIndexerController;
    let loggerErrorSpy: ReturnType<typeof vi.spyOn>;

    const ops = [{ index: 'variants', operation: { update: { _id: '1_1_en' } } }] as any;

    beforeEach(() => {
        fakeAdapter = { bulk: vi.fn(), close: vi.fn() };
        loggerErrorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
        vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);

        const options = {
            indexPrefix: 'test-',
            adapter: () => fakeAdapter,
            hydrateProductRelations: [],
            hydrateProductVariantRelations: [],
        } as any;

        controller = new ElasticsearchIndexerController(
            {} as any,
            options,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
        controller.onModuleInit();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('resolves and calls the adapter once when the bulk response has no errors', async () => {
        fakeAdapter.bulk.mockResolvedValue({
            body: { took: 1, errors: false, items: [{ update: { _id: '1_1_en', status: 200 } }] },
        });

        await expect(
            controller.executeBulkOperationsByChunks(3000, ops, 'variants'),
        ).resolves.toBeUndefined();

        expect(fakeAdapter.bulk).toHaveBeenCalledTimes(1);
        expect(fakeAdapter.bulk).toHaveBeenCalledWith(
            expect.objectContaining({ index: 'test-variants', refresh: true }),
        );
        expect(loggerErrorSpy).not.toHaveBeenCalled();
    });

    it('resolves and logs nothing when the only failures are not_found deletes', async () => {
        fakeAdapter.bulk.mockResolvedValue({
            body: {
                took: 1,
                errors: false,
                items: [{ delete: { _id: '1_1_en', status: 404, result: 'not_found' } }],
            },
        });

        await expect(
            controller.executeBulkOperationsByChunks(3000, ops, 'variants'),
        ).resolves.toBeUndefined();

        expect(loggerErrorSpy).not.toHaveBeenCalled();
    });

    it('rejects with BulkOperationError and logs once when bulk items report errors', async () => {
        fakeAdapter.bulk.mockResolvedValue({
            body: {
                took: 1,
                errors: true,
                items: [
                    {
                        delete: {
                            _id: '1_1_en',
                            status: 400,
                            error: {
                                type: 'illegal_argument_exception',
                                reason: 'no write index is defined for alias [test-variants]',
                            },
                        },
                    },
                    {
                        delete: {
                            _id: '1_2_en',
                            status: 400,
                            error: {
                                type: 'illegal_argument_exception',
                                reason: 'no write index is defined for alias [test-variants]',
                            },
                        },
                    },
                ],
            },
        });

        await expect(
            controller.executeBulkOperationsByChunks(3000, ops, 'variants'),
        ).rejects.toBeInstanceOf(BulkOperationError);

        expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
        expect(loggerErrorSpy.mock.calls[0][0]).toContain('no write index');
    });

    it('rethrows the original error when adapter.bulk rejects', async () => {
        const originalError = new Error('connect ECONNREFUSED');
        fakeAdapter.bulk.mockRejectedValue(originalError);

        await expect(
            controller.executeBulkOperationsByChunks(3000, ops, 'variants'),
        ).rejects.toBe(originalError);

        expect(loggerErrorSpy).toHaveBeenCalled();
    });
});
