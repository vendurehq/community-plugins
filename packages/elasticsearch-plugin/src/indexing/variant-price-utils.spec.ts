import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ProductVariant, ProductVariantPrice } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import { hasExplicitVariantPrice, shouldSkipVariantForCurrency } from './variant-price-utils';

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
});
