import type { BulkResponseBody } from '../adapter/search-client-adapter';
import { describe, expect, it } from 'vitest';

import { BulkOperationError, summarizeBulkResponse } from './bulk-errors';

function toBody(items: Array<Record<string, any>>): BulkResponseBody {
    return { took: 1, errors: items.some(item => Object.values(item)[0]?.error != null), items };
}

describe('summarizeBulkResponse()', () => {
    it('all ok', () => {
        const body = toBody([
            { index: { _id: '1', status: 201 } },
            { update: { _id: '2', status: 200 } },
            { delete: { _id: '3', status: 200 } },
        ]);

        const result = summarizeBulkResponse(body);

        expect(result.failures).toEqual([]);
        expect(result.notFoundDeletes).toBe(0);
        expect(result.total).toBe(3);
    });

    it('only not_found deletes', () => {
        const body = toBody([
            { delete: { _id: '1', status: 404, result: 'not_found' } },
            { delete: { _id: '2', status: 404, result: 'not_found' } },
        ]);

        const result = summarizeBulkResponse(body);

        expect(result.failures).toEqual([]);
        expect(result.notFoundDeletes).toBe(2);
        expect(result.total).toBe(2);
    });

    it('mixed: not_found delete, ok index, failing update and failing delete', () => {
        const body = toBody([
            { delete: { _id: '1', status: 404, result: 'not_found' } },
            { index: { _id: '2', status: 201 } },
            {
                update: {
                    _id: '3',
                    status: 400,
                    error: { type: 'document_parsing_exception', reason: 'failed to parse field' },
                },
            },
            {
                delete: {
                    _id: '4',
                    status: 400,
                    error: {
                        type: 'illegal_argument_exception',
                        reason: 'no write index is defined for alias [vendure-variants]',
                    },
                },
            },
        ]);

        const result = summarizeBulkResponse(body);

        expect(result.total).toBe(4);
        expect(result.notFoundDeletes).toBe(1);
        expect(result.failures).toEqual([
            {
                operation: 'update',
                id: '3',
                status: 400,
                type: 'document_parsing_exception',
                reason: 'failed to parse field',
            },
            {
                operation: 'delete',
                id: '4',
                status: 400,
                type: 'illegal_argument_exception',
                reason: 'no write index is defined for alias [vendure-variants]',
            },
        ]);

        const error = new BulkOperationError('vendure-variants', result.failures, result.total);

        expect(error.name).toBe('BulkOperationError');
        expect(error).toBeInstanceOf(BulkOperationError);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('2 of 4 items errored');
        expect(error.message).toContain('failed to parse field');
        expect(error.message).toContain('no write index is defined for alias [vendure-variants]');
        expect(error.message).toContain('[update 3]');
        expect(error.message).toContain('[delete 4]');
    });

    it('seven failures cap the reported examples at five and truncate long reasons', () => {
        const longReason = 'x'.repeat(300);
        const items = Array.from({ length: 7 }, (_, i) => ({
            index: {
                _id: `${i}`,
                status: 400,
                error: {
                    type: 'mapper_parsing_exception',
                    reason: i === 0 ? longReason : `reason-${i}`,
                },
            },
        }));

        const result = summarizeBulkResponse(toBody(items));
        const error = new BulkOperationError('vendure-variants', result.failures, result.total);

        expect(result.failures).toHaveLength(7);
        expect(error.message.match(/\[/g)).toHaveLength(5);
        expect(error.message.endsWith(' and 2 more')).toBe(true);
        expect(error.message).toContain('x'.repeat(200));
        expect(error.message).not.toContain('x'.repeat(201));
    });

    it('tolerates a body without items', () => {
        const result = summarizeBulkResponse({ took: 1, errors: false } as BulkResponseBody);

        expect(result).toEqual({ total: 0, failures: [], notFoundDeletes: 0 });
    });

    it('tolerates items missing status/result and a string error, without throwing', () => {
        const body = toBody([
            { index: { _id: '1' } },
            { create: { error: 'plain string error' } },
        ]);

        const result = summarizeBulkResponse(body);

        expect(result.total).toBe(2);
        expect(result.failures).toEqual([
            {
                operation: 'create',
                id: '',
                status: 0,
                type: undefined,
                reason: 'plain string error',
            },
        ]);
    });
});
