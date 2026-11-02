import { errors } from '@opensearch-project/opensearch';
import { Logger } from '@vendure/core';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIndices, describeSearchClientError } from './indexing-utils';

function createMockAdapter(createImpl?: () => Promise<{ body: any }>) {
    const created: string[] = [];
    const aliased: Array<{ index: string; name: string }> = [];
    const adapter: any = {
        indices: {
            create: vi.fn(({ index }: { index: string }) => {
                if (createImpl) {
                    return createImpl();
                }
                created.push(index);
                return Promise.resolve({ body: {} });
            }),
            putAlias: vi.fn(({ index, name }: { index: string; name: string }) => {
                aliased.push({ index, name });
                return Promise.resolve({ body: {} });
            }),
        },
    };
    return { adapter, created, aliased };
}

describe('describeSearchClientError()', () => {
    it('recovers the message that JSON.stringify() drops from a TimeoutError', () => {
        const error = new errors.TimeoutError('Request timed out', {} as any);

        // `message` and `stack` are non-enumerable on the client error classes, so
        // stringifying loses the only human-readable part of the error.
        expect(JSON.stringify(error)).not.toContain('Request timed out');

        expect(describeSearchClientError(error)).toBe('Request timed out');
    });

    it('includes the server response body of a ResponseError', () => {
        const error = new errors.ResponseError({
            body: { error: { type: 'index_not_found_exception', index: 'temp-1-abc-variants' } },
            statusCode: 404,
        } as any);

        const description = describeSearchClientError(error);

        expect(description).toContain('index_not_found_exception');
        expect(description).toContain('temp-1-abc-variants');
    });

    it('handles non-object errors', () => {
        expect(describeSearchClientError('boom')).toBe('boom');
        expect(describeSearchClientError(undefined)).toBe('undefined');
        expect(describeSearchClientError(null)).toBe('null');
    });
});

describe('createIndices()', () => {
    let errorSpy: MockInstance;

    beforeEach(() => {
        errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
        vi.spyOn(Logger, 'verbose').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('creates the index and maps the alias', async () => {
        const { adapter, created, aliased } = createMockAdapter();

        await createIndices(adapter, 'test-', {}, {});

        expect(created).toHaveLength(1);
        expect(created[0]).toMatch(/^test-variants\d+$/);
        expect(aliased).toEqual([{ index: created[0], name: 'test-variants' }]);
    });

    it('creates the index under the alias name directly when mapAlias is false', async () => {
        const { adapter, created, aliased } = createMockAdapter();

        await createIndices(adapter, 'temp-1-abc-', {}, {}, false);

        expect(created).toEqual(['temp-1-abc-variants']);
        expect(aliased).toEqual([]);
    });

    it('rethrows when the index could not be created', async () => {
        const error = new errors.TimeoutError('Request timed out', {} as any);
        const { adapter } = createMockAdapter(() => Promise.reject(error));

        await expect(createIndices(adapter, 'test-', {}, {})).rejects.toBe(error);
    });

    it('does not log the failure itself, leaving that to the caller', async () => {
        const error = new errors.TimeoutError('Request timed out', {} as any);
        const { adapter } = createMockAdapter(() => Promise.reject(error));

        await expect(createIndices(adapter, 'test-', {}, {})).rejects.toBe(error);

        // Logging here as well as in the caller reported every failure twice, and turned
        // the purely diagnostic drift check into an ERROR line.
        expect(errorSpy).not.toHaveBeenCalled();
    });
});
