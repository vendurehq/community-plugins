import { LanguageCode, LogicalOperator, SortOrder } from '@vendure/common/lib/generated-types';
import { Channel, RequestContext } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import { buildFilter, buildSort, escapeFilterValue } from './build-search-query';
import { defaultOptions } from './options';

describe('escapeFilterValue()', () => {
    it('returns plain strings unchanged', () => {
        expect(escapeFilterValue('hello')).toBe('hello');
    });

    it('escapes double quotes', () => {
        expect(escapeFilterValue('say "hello"')).toBe('say \\"hello\\"');
    });

    it('escapes backslashes', () => {
        expect(escapeFilterValue('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('escapes both backslashes and quotes', () => {
        expect(escapeFilterValue('a\\"b')).toBe('a\\\\\\"b');
    });

    it('handles numbers', () => {
        expect(escapeFilterValue(42)).toBe('42');
    });
});

describe('buildFilter()', () => {
    const CHANNEL_ID = 1;
    const ctx = new RequestContext({
        apiType: 'shop',
        isAuthorized: false,
        authorizedAsOwnerOnly: false,
        channel: new Channel({ id: CHANNEL_ID }),
        languageCode: LanguageCode.en,
    });

    it('includes channelId and languageCode', () => {
        const result = buildFilter(ctx, { term: '' }, false);
        expect(result).toContain('channelId = "1"');
        expect(result).toContain('languageCode = "en"');
    });

    it('adds enabled filter when enabledOnly is true', () => {
        const result = buildFilter(ctx, { term: '' }, true);
        expect(result).toContain('enabled = true');
    });

    it('does not add enabled filter when enabledOnly is false', () => {
        const result = buildFilter(ctx, { term: '' }, false);
        expect(result).not.toContain('enabled');
    });

    it('filters by facetValueIds with AND operator', () => {
        const result = buildFilter(ctx, {
            term: '',
            facetValueIds: ['1', '2'],
            facetValueOperator: LogicalOperator.AND,
        }, false);
        expect(result).toContain('facetValueIds = "1"');
        expect(result).toContain('facetValueIds = "2"');
        expect(result).not.toContain(' OR ');
    });

    it('filters by facetValueIds with OR operator', () => {
        const result = buildFilter(ctx, {
            term: '',
            facetValueIds: ['1', '2'],
            facetValueOperator: LogicalOperator.OR,
        }, false);
        expect(result).toContain('(facetValueIds = "1" OR facetValueIds = "2")');
    });

    it('filters by collectionId', () => {
        const result = buildFilter(ctx, { term: '', collectionId: 'T_5' }, false);
        expect(result).toContain('collectionIds = "T_5"');
    });

    it('filters by collectionSlug', () => {
        const result = buildFilter(ctx, { term: '', collectionSlug: 'electronics' }, false);
        expect(result).toContain('collectionSlugs = "electronics"');
    });

    it('filters by multiple collectionIds with OR', () => {
        const result = buildFilter(ctx, { term: '', collectionIds: ['1', '2', '3'] } as any, false);
        expect(result).toContain('(collectionIds = "1" OR collectionIds = "2" OR collectionIds = "3")');
    });

    it('deduplicates collectionIds', () => {
        const result = buildFilter(ctx, { term: '', collectionIds: ['1', '1', '2'] } as any, false);
        expect(result).toContain('(collectionIds = "1" OR collectionIds = "2")');
        // Should not have "1" twice
        const matches = result.match(/collectionIds = "1"/g);
        expect(matches?.length).toBe(1);
    });

    it('filters by priceRange', () => {
        const result = buildFilter(ctx, {
            term: '',
            priceRange: { min: 1000, max: 5000 },
        }, false);
        expect(result).toContain('price >= 1000');
        expect(result).toContain('price <= 5000');
    });

    it('filters by priceRangeWithTax', () => {
        const result = buildFilter(ctx, {
            term: '',
            priceRangeWithTax: { min: 1200, max: 6000 },
        }, false);
        expect(result).toContain('priceWithTax >= 1200');
        expect(result).toContain('priceWithTax <= 6000');
    });

    it('filters inStock for variants', () => {
        const result = buildFilter(ctx, { term: '', inStock: true }, false);
        expect(result).toContain('inStock = true');
        expect(result).not.toContain('productInStock');
    });

    it('filters inStock for grouped products', () => {
        const result = buildFilter(ctx, { term: '', inStock: true, groupByProduct: true }, false);
        expect(result).toContain('productInStock = true');
        expect(result).not.toContain('inStock = true');
    });

    it('escapes special characters in collectionSlug', () => {
        const result = buildFilter(ctx, { term: '', collectionSlug: 'test"inject' }, false);
        expect(result).toContain('collectionSlugs = "test\\"inject"');
    });

    it('escapes special characters in facetValueIds', () => {
        const result = buildFilter(ctx, {
            term: '',
            facetValueIds: ['normal', 'has"quote'],
            facetValueOperator: LogicalOperator.OR,
        }, false);
        expect(result).toContain('facetValueIds = "has\\"quote"');
    });

    it('throws on invalid facetValueFilter with both and + or', () => {
        expect(() => buildFilter(ctx, {
            term: '',
            facetValueFilters: [{ and: '1', or: ['2', '3'] }],
        }, false)).toThrow();
    });

    it('handles facetValueFilters with AND', () => {
        const result = buildFilter(ctx, {
            term: '',
            facetValueFilters: [{ and: '5' }],
        }, false);
        expect(result).toContain('facetValueIds = "5"');
    });

    it('handles facetValueFilters with OR', () => {
        const result = buildFilter(ctx, {
            term: '',
            facetValueFilters: [{ or: ['3', '4'] }],
        }, false);
        expect(result).toContain('(facetValueIds = "3" OR facetValueIds = "4")');
    });

    it('joins all parts with AND', () => {
        const result = buildFilter(ctx, {
            term: '',
            collectionId: '1',
            inStock: true,
        }, true);
        const parts = result.split(' AND ');
        expect(parts.length).toBeGreaterThanOrEqual(4); // channelId, languageCode, enabled, collectionId, inStock
    });
});

describe('buildSort()', () => {
    const options = defaultOptions;

    it('returns empty array when no sort specified', () => {
        const result = buildSort({ term: '' }, options);
        expect(result).toEqual([]);
    });

    it('sorts by name ascending', () => {
        const result = buildSort({ term: '', sort: { name: SortOrder.ASC } }, options);
        expect(result).toContain('productName:asc');
    });

    it('sorts by name descending', () => {
        const result = buildSort({ term: '', sort: { name: SortOrder.DESC } }, options);
        expect(result).toContain('productName:desc');
    });

    it('sorts by price ascending', () => {
        const result = buildSort({ term: '', sort: { price: SortOrder.ASC } }, options);
        expect(result).toContain('price:asc');
    });

    it('sorts by both name and price', () => {
        const result = buildSort({ term: '', sort: { name: SortOrder.ASC, price: SortOrder.DESC } }, options);
        expect(result).toContain('productName:asc');
        expect(result).toContain('price:desc');
    });

    it('applies mapSort hook', () => {
        const optionsWithHook = {
            ...options,
            searchConfig: {
                ...options.searchConfig,
                mapSort: (sort: string[]) => [...sort, 'custom:asc'],
            },
        };
        const result = buildSort({ term: '' }, optionsWithHook);
        expect(result).toContain('custom:asc');
    });
});
