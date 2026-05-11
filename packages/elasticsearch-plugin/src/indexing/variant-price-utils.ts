import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ID, idsAreEqual, ProductVariant } from '@vendure/core';

/**
 * Eager copy of the price-related fields that `ProductPriceApplicator.applyChannelPriceAndTax`
 * mutates in place on a `ProductVariant`. The indexer reuses the same variant object
 * across `(channel, currency)` iterations; taking a snapshot at the moment of use makes
 * the produced index document immune to subsequent mutations by later iterations.
 */
export interface VariantPriceSnapshot {
    price: number;
    priceWithTax: number;
    currencyCode: CurrencyCode;
}

/**
 * Snapshot of the per-variant price aggregations consumed when computing
 * `productPriceMin/Max` and `productPriceWithTaxMin/Max` for the index item.
 */
export interface ProductPriceAggregateSnapshot {
    prices: number[];
    pricesWithTax: number[];
}

/**
 * Returns `true` if the given variant has a `ProductVariantPrice` row that matches the
 * supplied `(channelId, currencyCode)` pair. Used by the indexer to avoid producing a
 * phantom `price: 0` document when `applyChannelPriceAndTax` falls back to zero because
 * no price exists for the requested currency in the active channel.
 */
export function hasExplicitVariantPrice(
    variant: Pick<ProductVariant, 'productVariantPrices'>,
    channelId: ID,
    currencyCode: CurrencyCode,
): boolean {
    return (
        variant.productVariantPrices?.some(
            p => p.currencyCode === currencyCode && idsAreEqual(p.channelId, channelId),
        ) ?? false
    );
}

/**
 * Combines the explicit-price probe with the post-`applyChannelPriceAndTax` state of
 * the variant: returns `true` only when there is no price row for `(channel, currency)`
 * AND the applicator has left `listPrice` at `0`. This is the signal that indexing the
 * variant for the current currency would produce a misleading zero-priced document.
 */
export function shouldSkipVariantForCurrency(
    variant: Pick<ProductVariant, 'productVariantPrices' | 'listPrice'>,
    channelId: ID,
    currencyCode: CurrencyCode,
): boolean {
    return !hasExplicitVariantPrice(variant, channelId, currencyCode) && variant.listPrice === 0;
}

/**
 * Captures the price-related fields of a single variant *as they stand right now*.
 * Decouples the indexed document from any later in-place mutation of the same
 * variant instance (typically by the next currency iteration's
 * `applyChannelPriceAndTax`).
 */
export function snapshotVariantPrice(
    variant: Pick<ProductVariant, 'price' | 'priceWithTax' | 'currencyCode'>,
): VariantPriceSnapshot {
    return {
        price: variant.price,
        priceWithTax: variant.priceWithTax,
        currencyCode: variant.currencyCode,
    };
}

/**
 * Captures the per-variant price aggregates needed for the product-level
 * `productPriceMin/Max` and `productPriceWithTaxMin/Max` fields. Same rationale
 * as {@link snapshotVariantPrice}: pin the values at the moment of use so that
 * subsequent mutations on the same array of variant instances cannot leak into
 * an already-composed index item.
 */
export function snapshotProductPriceAggregates(
    variants: Array<Pick<ProductVariant, 'price' | 'priceWithTax'>>,
): ProductPriceAggregateSnapshot {
    return {
        prices: variants.map(v => v.price),
        pricesWithTax: variants.map(v => v.priceWithTax),
    };
}
