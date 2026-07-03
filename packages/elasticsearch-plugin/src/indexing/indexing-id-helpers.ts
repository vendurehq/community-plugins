import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { Channel, ID } from '@vendure/core';
import { LanguageCode } from '@vendure/core';

/**
 * Builds the Elasticsearch `_id` for a variant document.
 *
 * When `indexCurrencyCode` is `false` (the default), the legacy 3-part shape
 * `{channelId}_{entityId}_{languageCode}` is used so that existing single-currency
 * deployments do not require a reindex when upgrading. When `true`, the 4-part
 * shape including `currencyCode` is used to disambiguate per-currency documents.
 */
export function buildVariantDocId(
    indexCurrencyCode: boolean,
    entityId: ID,
    channelId: ID,
    languageCode: LanguageCode,
    currencyCode: CurrencyCode,
): string {
    const base = `${channelId.toString()}_${entityId.toString()}_${languageCode}`;
    return indexCurrencyCode ? `${base}_${currencyCode}` : base;
}

/**
 * Returns the set of currencies that should be indexed for the given channel.
 *
 * When `indexCurrencyCode` is disabled, only the channel's `defaultCurrencyCode`
 * is returned — preserving the pre-multi-currency single-doc behaviour. When
 * enabled, the channel's full `availableCurrencyCodes` set is returned (falling
 * back to `[defaultCurrencyCode]` if the channel does not expose an explicit list).
 */
export function resolveChannelIndexCurrencies(
    indexCurrencyCode: boolean,
    channel: Pick<Channel, 'defaultCurrencyCode' | 'availableCurrencyCodes'>,
): CurrencyCode[] {
    if (!indexCurrencyCode) {
        return [channel.defaultCurrencyCode];
    }
    return channel.availableCurrencyCodes?.length
        ? channel.availableCurrencyCodes
        : [channel.defaultCurrencyCode];
}
