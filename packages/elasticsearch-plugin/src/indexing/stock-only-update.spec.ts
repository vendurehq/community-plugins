import { describe, expect, it } from 'vitest';

import { isStockOnlyVariantUpdate } from './stock-only-update';

describe('isStockOnlyVariantUpdate', () => {
    it('is true when only stock-level fields are present', () => {
        expect(isStockOnlyVariantUpdate([{ id: '1', stockOnHand: 40 }])).toBe(true);
        expect(
            isStockOnlyVariantUpdate([
                { id: '1', stockOnHand: 40, trackInventory: 'TRUE' },
                { id: '2', stockLevels: [{ stockLocationId: '1', stockOnHand: 5 }] },
            ]),
        ).toBe(true);
        expect(
            isStockOnlyVariantUpdate([{ id: '1', outOfStockThreshold: 0, useGlobalOutOfStockThreshold: false }]),
        ).toBe(true);
    });

    it('is false when an index-affecting field is present', () => {
        expect(isStockOnlyVariantUpdate([{ id: '1', stockOnHand: 40, price: 999 }])).toBe(false);
        expect(isStockOnlyVariantUpdate([{ id: '1', sku: 'NEW' }])).toBe(false);
        expect(isStockOnlyVariantUpdate([{ id: '1', enabled: false }])).toBe(false);
        expect(isStockOnlyVariantUpdate([{ id: '1', facetValueIds: ['2'] }])).toBe(false);
        expect(isStockOnlyVariantUpdate([{ id: '1', translations: [] }])).toBe(false);
        // taxCategoryId changes priceWithTax, so it is not stock-only.
        expect(isStockOnlyVariantUpdate([{ id: '1', stockOnHand: 40, taxCategoryId: '2' }])).toBe(false);
    });

    it('is false when any entry in the batch is not stock-only', () => {
        expect(
            isStockOnlyVariantUpdate([
                { id: '1', stockOnHand: 40 },
                { id: '2', price: 100 },
            ]),
        ).toBe(false);
    });

    it('is false for non-array, empty, or id-list inputs', () => {
        expect(isStockOnlyVariantUpdate(undefined)).toBe(false);
        expect(isStockOnlyVariantUpdate([])).toBe(false);
        expect(isStockOnlyVariantUpdate('T_1')).toBe(false);
        expect(isStockOnlyVariantUpdate(['T_1', 'T_2'])).toBe(false);
        expect(isStockOnlyVariantUpdate(42)).toBe(false);
    });
});
