import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ID, idsAreEqual, ProductVariant } from '@vendure/core';

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
