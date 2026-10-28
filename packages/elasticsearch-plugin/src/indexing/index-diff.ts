import equal from 'fast-deep-equal/es6';

export interface IndexedDocument {
    _id: string;
    _source: any;
}

/**
 * Returns `true` when a freshly built document is equal to what is stored in the index. The built
 * document is passed through `JSON.parse(JSON.stringify(...))` so it is compared in the same shape
 * the index holds it: `undefined` fields dropped, `Date`s rendered as ISO strings, and key order
 * irrelevant (the deep-equal ignores it).
 */
export function builtDocumentMatchesIndexed(builtDocument: unknown, indexedSource: unknown): boolean {
    return equal(JSON.parse(JSON.stringify(builtDocument)), indexedSource);
}

/**
 * Compares the freshly built documents for a product (keyed by `_id`) against the documents
 * currently in the index and returns the minimal set of changes:
 *
 * - `upsertIds`: built documents that are new or whose content differs from the index.
 * - `deleteIds`: indexed documents that no longer exist in the built set.
 *
 * When both are empty the product is already correctly indexed and nothing needs to be written.
 */
export function diffProductDocuments(
    builtById: Map<string, unknown>,
    currentDocuments: IndexedDocument[],
): { upsertIds: string[]; deleteIds: string[] } {
    const currentById = new Map<string, any>();
    for (const doc of currentDocuments) {
        currentById.set(doc._id, doc._source);
    }
    const upsertIds: string[] = [];
    for (const [id, builtDocument] of builtById) {
        const indexedSource = currentById.get(id);
        if (indexedSource === undefined || !builtDocumentMatchesIndexed(builtDocument, indexedSource)) {
            upsertIds.push(id);
        }
    }
    const deleteIds: string[] = [];
    for (const id of currentById.keys()) {
        if (!builtById.has(id)) {
            deleteIds.push(id);
        }
    }
    return { upsertIds, deleteIds };
}
