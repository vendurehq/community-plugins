import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ProductVariant, ProductVariantPrice } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import {
    hasExplicitVariantPrice,
    shouldSkipVariantForCurrency,
    snapshotProductPriceAggregates,
    snapshotVariantPrice,
} from './variant-price-utils';

function variant(prices: Array<Partial<ProductVariantPrice>>, listPrice = 0): ProductVariant {
    return {
        productVariantPrices: prices as ProductVariantPrice[],
        listPrice,
    } as unknown as ProductVariant;
}

describe('variant-price-utils', () => {
    describe('hasExplicitVariantPrice()', () => {
        it('returns true when a price row matches both channel and currency', () => {
            const v = variant([
                { channelId: 2, currencyCode: CurrencyCode.GBP },
                { channelId: 2, currencyCode: CurrencyCode.EUR },
            ]);
            expect(hasExplicitVariantPrice(v, 2, CurrencyCode.EUR)).toBe(true);
        });

        it('returns false when currency matches but channel does not', () => {
            const v = variant([{ channelId: 1, currencyCode: CurrencyCode.EUR }]);
            expect(hasExplicitVariantPrice(v, 2, CurrencyCode.EUR)).toBe(false);
        });

        it('returns false when channel matches but currency does not', () => {
            const v = variant([{ channelId: 2, currencyCode: CurrencyCode.GBP }]);
            expect(hasExplicitVariantPrice(v, 2, CurrencyCode.EUR)).toBe(false);
        });

        it('handles string channel ids via idsAreEqual', () => {
            const v = variant([{ channelId: '2', currencyCode: CurrencyCode.EUR }]);
            expect(hasExplicitVariantPrice(v, 2, CurrencyCode.EUR)).toBe(true);
        });

        it('returns false when productVariantPrices is empty', () => {
            const v = variant([]);
            expect(hasExplicitVariantPrice(v, 2, CurrencyCode.EUR)).toBe(false);
        });

        it('returns false when productVariantPrices is undefined', () => {
            const v = { productVariantPrices: undefined } as unknown as ProductVariant;
            expect(hasExplicitVariantPrice(v, 2, CurrencyCode.EUR)).toBe(false);
        });
    });

    describe('shouldSkipVariantForCurrency()', () => {
        it('skips when no matching price row AND listPrice is zero', () => {
            const v = variant([{ channelId: 2, currencyCode: CurrencyCode.GBP }], 0);
            expect(shouldSkipVariantForCurrency(v, 2, CurrencyCode.EUR)).toBe(true);
        });

        it('does not skip when an explicit price row exists, even if listPrice is zero', () => {
            // listPrice may be 0 transiently (e.g. tax strategy quirks); the explicit
            // ProductVariantPrice row is the source of truth that the variant is "priced".
            const v = variant([{ channelId: 2, currencyCode: CurrencyCode.EUR, price: 0 }], 0);
            expect(shouldSkipVariantForCurrency(v, 2, CurrencyCode.EUR)).toBe(false);
        });

        it('does not skip when listPrice is non-zero, even if no matching price row', () => {
            // Defensive: should never happen if applyChannelPriceAndTax behaves as
            // documented, but the guard remains strict — non-zero price is always indexed.
            const v = variant([], 1500);
            expect(shouldSkipVariantForCurrency(v, 2, CurrencyCode.EUR)).toBe(false);
        });

        it('does not skip when both a matching price row and a non-zero listPrice are present', () => {
            const v = variant([{ channelId: 2, currencyCode: CurrencyCode.EUR }], 1500);
            expect(shouldSkipVariantForCurrency(v, 2, CurrencyCode.EUR)).toBe(false);
        });
    });

    describe('snapshotVariantPrice()', () => {
        it('captures the variant price fields by value', () => {
            const v = {
                price: 1500,
                priceWithTax: 1800,
                currencyCode: CurrencyCode.EUR,
            } as unknown as ProductVariant;
            const snap = snapshotVariantPrice(v);
            expect(snap).toEqual({
                price: 1500,
                priceWithTax: 1800,
                currencyCode: CurrencyCode.EUR,
            });
        });

        it('is decoupled from later mutations of the source variant', () => {
            const v = {
                price: 1500,
                priceWithTax: 1800,
                currencyCode: CurrencyCode.EUR,
            } as unknown as ProductVariant;
            const snap = snapshotVariantPrice(v);
            // Simulate a subsequent applyChannelPriceAndTax overwriting the same
            // variant instance for the next currency iteration.
            v.price = 9999;
            v.priceWithTax = 9999;
            v.currencyCode = CurrencyCode.GBP;
            expect(snap).toEqual({
                price: 1500,
                priceWithTax: 1800,
                currencyCode: CurrencyCode.EUR,
            });
        });
    });

    describe('snapshotProductPriceAggregates()', () => {
        it('captures per-variant price + priceWithTax arrays', () => {
            const variants = [
                { price: 100, priceWithTax: 120 },
                { price: 200, priceWithTax: 240 },
                { price: 300, priceWithTax: 360 },
            ] as unknown as ProductVariant[];
            const snap = snapshotProductPriceAggregates(variants);
            expect(snap.prices).toEqual([100, 200, 300]);
            expect(snap.pricesWithTax).toEqual([120, 240, 360]);
        });

        it('is decoupled from later mutations of the source variants', () => {
            const variants = [
                { price: 100, priceWithTax: 120 },
                { price: 200, priceWithTax: 240 },
            ] as unknown as ProductVariant[];
            const snap = snapshotProductPriceAggregates(variants);
            // Simulate the next currency iteration overwriting the same instances.
            variants[0].price = 999;
            variants[1].priceWithTax = 999;
            expect(snap.prices).toEqual([100, 200]);
            expect(snap.pricesWithTax).toEqual([120, 240]);
        });

        it('returns empty arrays when no variants are passed', () => {
            const snap = snapshotProductPriceAggregates([]);
            expect(snap).toEqual({ prices: [], pricesWithTax: [] });
        });
    });
});
