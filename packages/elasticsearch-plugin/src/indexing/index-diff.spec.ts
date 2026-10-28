import { describe, expect, it } from 'vitest';

import { builtDocumentMatchesIndexed, diffProductDocuments, IndexedDocument } from './index-diff';

describe('builtDocumentMatchesIndexed', () => {
    it('matches regardless of key order', () => {
        const built = { inStock: true, sku: 'A', facetIds: ['1', '2'] };
        const indexed = { facetIds: ['1', '2'], sku: 'A', inStock: true };
        expect(builtDocumentMatchesIndexed(built, indexed)).toBe(true);
    });

    it('does not match when a field differs', () => {
        expect(builtDocumentMatchesIndexed({ inStock: true }, { inStock: false })).toBe(false);
    });

    it('treats an undefined field the same as an absent one (as the index stores it)', () => {
        // Elasticsearch drops undefined fields from _source, so the built doc must compare equal.
        expect(builtDocumentMatchesIndexed({ sku: 'A', productAssetId: undefined }, { sku: 'A' })).toBe(true);
    });

    it('matches a Date against the ISO string the index stores', () => {
        // The old stableStringify serialised a Date to {}, so a Date-valued custom mapping never
        // matched its own _source and the update was never skipped. The JSON round-trip fixes this.
        const date = new Date('2026-01-02T03:04:05.000Z');
        const built = { 'product-restockAt': date };
        const indexed = { 'product-restockAt': '2026-01-02T03:04:05.000Z' };
        expect(builtDocumentMatchesIndexed(built, indexed)).toBe(true);
    });

    it('distinguishes a number from a numeric string', () => {
        expect(builtDocumentMatchesIndexed({ n: 2 }, { n: '2' })).toBe(false);
    });

    it('is array-order sensitive', () => {
        expect(builtDocumentMatchesIndexed({ facetIds: ['1', '2'] }, { facetIds: ['2', '1'] })).toBe(false);
    });
});

describe('diffProductDocuments', () => {
    const built = new Map<string, unknown>([
        ['1_10_en', { inStock: true, sku: 'A', facetIds: ['1', '2'] }],
        ['1_11_en', { inStock: false, sku: 'B', facetIds: [] }],
    ]);

    it('returns no changes when the index already matches (key order aside)', () => {
        const current: IndexedDocument[] = [
            { _id: '1_11_en', _source: { facetIds: [], sku: 'B', inStock: false } },
            { _id: '1_10_en', _source: { facetIds: ['1', '2'], sku: 'A', inStock: true } },
        ];
        const { upsertIds, deleteIds } = diffProductDocuments(built, current);
        expect(upsertIds).toEqual([]);
        expect(deleteIds).toEqual([]);
    });

    it('upserts only the document whose content changed', () => {
        const current: IndexedDocument[] = [
            { _id: '1_10_en', _source: { inStock: false, sku: 'A', facetIds: ['1', '2'] } },
            { _id: '1_11_en', _source: { inStock: false, sku: 'B', facetIds: [] } },
        ];
        const { upsertIds, deleteIds } = diffProductDocuments(built, current);
        expect(upsertIds).toEqual(['1_10_en']);
        expect(deleteIds).toEqual([]);
    });

    it('upserts a new document that is not yet indexed', () => {
        const current: IndexedDocument[] = [
            { _id: '1_10_en', _source: { inStock: true, sku: 'A', facetIds: ['1', '2'] } },
        ];
        const { upsertIds, deleteIds } = diffProductDocuments(built, current);
        expect(upsertIds).toEqual(['1_11_en']);
        expect(deleteIds).toEqual([]);
    });

    it('deletes an indexed document that no longer exists in the built set', () => {
        const current: IndexedDocument[] = [
            { _id: '1_10_en', _source: { inStock: true, sku: 'A', facetIds: ['1', '2'] } },
            { _id: '1_11_en', _source: { inStock: false, sku: 'B', facetIds: [] } },
            { _id: '1_12_en', _source: { inStock: true, sku: 'C', facetIds: [] } },
        ];
        const { upsertIds, deleteIds } = diffProductDocuments(built, current);
        expect(upsertIds).toEqual([]);
        expect(deleteIds).toEqual(['1_12_en']);
    });

    it('flags a stock-derived custom-field change (the onStockStatusChange correctness invariant)', () => {
        const builtWithCustom = new Map<string, unknown>([
            ['1_10_en', { inStock: true, 'product-stockCount': 5 }],
        ]);
        const current: IndexedDocument[] = [
            { _id: '1_10_en', _source: { inStock: true, 'product-stockCount': 4 } },
        ];
        const { upsertIds } = diffProductDocuments(builtWithCustom, current);
        expect(upsertIds).toEqual(['1_10_en']);
    });

    it('upserts everything when the index is empty', () => {
        const { upsertIds, deleteIds } = diffProductDocuments(built, []);
        expect(new Set(upsertIds)).toEqual(new Set(['1_10_en', '1_11_en']));
        expect(deleteIds).toEqual([]);
    });

    it('deletes everything when the built set is empty (product removed)', () => {
        const current: IndexedDocument[] = [
            { _id: '1_10_en', _source: { inStock: true } },
            { _id: '1_11_en', _source: { inStock: false } },
        ];
        const { upsertIds, deleteIds } = diffProductDocuments(new Map(), current);
        expect(upsertIds).toEqual([]);
        expect(new Set(deleteIds)).toEqual(new Set(['1_10_en', '1_11_en']));
    });
});
