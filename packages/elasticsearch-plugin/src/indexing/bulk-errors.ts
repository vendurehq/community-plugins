import type { BulkResponseBody } from '../adapter/search-client-adapter';

export const MAX_REPORTED_BULK_ERRORS = 5;
export const MAX_REASON_LENGTH = 200;

export interface BulkItemFailure {
    operation: string;
    id: string;
    status: number;
    type?: string;
    reason?: string;
}

export interface BulkResponseSummary {
    total: number;
    failures: BulkItemFailure[];
    notFoundDeletes: number;
}

/**
 * Classifies every item in a bulk response into failures and not-found deletes.
 * Never consults `body.errors`; every item is scanned individually and missing
 * fields are tolerated rather than throwing.
 */
export function summarizeBulkResponse(body: BulkResponseBody): BulkResponseSummary {
    const failures: BulkItemFailure[] = [];
    let notFoundDeletes = 0;
    const items = body.items ?? [];

    for (const item of items) {
        const op = Object.keys(item)[0] as string | undefined;
        const result = op !== undefined ? (item[op] as Record<string, any> | undefined) : undefined;

        if (result?.error != null) {
            failures.push(toBulkItemFailure(op as string, result));
        } else if (op === 'delete' && (result?.status === 404 || result?.result === 'not_found')) {
            notFoundDeletes++;
        }
    }

    return { total: items.length, failures, notFoundDeletes };
}

function toBulkItemFailure(operation: string, result: Record<string, any>): BulkItemFailure {
    const error: unknown = result.error;
    const id: string = result._id ?? '';
    const status: number = result.status ?? 0;

    if (typeof error === 'string') {
        return { operation, id, status, reason: error };
    }

    const isErrorObject = typeof error === 'object' && error !== null;
    const type = isErrorObject && typeof (error as any).type === 'string' ? (error as any).type : undefined;
    const reason =
        isErrorObject && typeof (error as any).reason === 'string'
            ? (error as any).reason
            : JSON.stringify(error);

    return { operation, id, status, type, reason };
}

function formatMessage(index: string, failures: BulkItemFailure[], total: number): string {
    const examples = failures.slice(0, MAX_REPORTED_BULK_ERRORS).map(failure => {
        const typePrefix = failure.type !== undefined ? `${failure.type}: ` : '';
        const reason = (failure.reason ?? '').slice(0, MAX_REASON_LENGTH);
        return `[${failure.operation} ${failure.id}] ${typePrefix}${reason}`;
    });

    let message = `Bulk operations on index "${index}" failed: ${failures.length} of ${total} items errored. ${examples.join('; ')}`;

    if (failures.length > MAX_REPORTED_BULK_ERRORS) {
        message += ` and ${failures.length - MAX_REPORTED_BULK_ERRORS} more`;
    }

    return message;
}

/**
 * Thrown by the indexer when the search backend rejects one or more items in a bulk
 * request. Carries the failing `index`, the individual `failures`, and the `total`
 * number of items in the bulk request. Consumers can `instanceof` this in custom
 * job handlers to distinguish bulk-item failures from other errors (e.g. connection
 * failures) raised during indexing.
 */
export class BulkOperationError extends Error {
    constructor(
        readonly index: string,
        readonly failures: BulkItemFailure[],
        readonly total: number,
    ) {
        super(formatMessage(index, failures, total));
        this.name = 'BulkOperationError';
    }
}
