import { CurrencyCode, LanguageCode } from '@vendure/common/lib/generated-types';
import { Channel } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import { buildVariantDocId, resolveChannelIndexCurrencies } from './indexing-id-helpers';

describe('indexing id helpers', () => {
    describe('buildVariantDocId()', () => {
        it('returns the legacy 3-part shape when indexCurrencyCode is disabled', () => {
            const id = buildVariantDocId(false, 7, 2, LanguageCode.en, CurrencyCode.USD);
            expect(id).toBe('2_7_en');
        });

        it('returns the 4-part shape including currency when indexCurrencyCode is enabled', () => {
            const id = buildVariantDocId(true, 7, 2, LanguageCode.en, CurrencyCode.USD);
            expect(id).toBe('2_7_en_USD');
        });

        it('handles string ids identically', () => {
            expect(buildVariantDocId(false, 'v-1', 'c-1', LanguageCode.fr, CurrencyCode.EUR)).toBe(
                'c-1_v-1_fr',
            );
            expect(buildVariantDocId(true, 'v-1', 'c-1', LanguageCode.fr, CurrencyCode.EUR)).toBe(
                'c-1_v-1_fr_EUR',
            );
        });

        it('encodes synthetic (negative) variant ids the same way for both modes', () => {
            expect(buildVariantDocId(false, -42, 1, LanguageCode.en, CurrencyCode.GBP)).toBe('1_-42_en');
            expect(buildVariantDocId(true, -42, 1, LanguageCode.en, CurrencyCode.GBP)).toBe(
                '1_-42_en_GBP',
            );
        });
    });

    describe('resolveChannelIndexCurrencies()', () => {
        it('returns [defaultCurrencyCode] when indexCurrencyCode is disabled, even if availableCurrencyCodes is non-empty', () => {
            const channel = new Channel({
                defaultCurrencyCode: CurrencyCode.USD,
                availableCurrencyCodes: [CurrencyCode.USD, CurrencyCode.EUR, CurrencyCode.GBP],
            });
            expect(resolveChannelIndexCurrencies(false, channel)).toEqual([CurrencyCode.USD]);
        });

        it('returns [defaultCurrencyCode] when indexCurrencyCode is disabled and availableCurrencyCodes is empty', () => {
            const channel = new Channel({
                defaultCurrencyCode: CurrencyCode.USD,
                availableCurrencyCodes: [],
            });
            expect(resolveChannelIndexCurrencies(false, channel)).toEqual([CurrencyCode.USD]);
        });

        it('returns availableCurrencyCodes when indexCurrencyCode is enabled', () => {
            const channel = new Channel({
                defaultCurrencyCode: CurrencyCode.USD,
                availableCurrencyCodes: [CurrencyCode.USD, CurrencyCode.EUR],
            });
            expect(resolveChannelIndexCurrencies(true, channel)).toEqual([
                CurrencyCode.USD,
                CurrencyCode.EUR,
            ]);
        });

        it('falls back to [defaultCurrencyCode] when indexCurrencyCode is enabled but availableCurrencyCodes is empty', () => {
            const channel = new Channel({
                defaultCurrencyCode: CurrencyCode.GBP,
                availableCurrencyCodes: [],
            });
            expect(resolveChannelIndexCurrencies(true, channel)).toEqual([CurrencyCode.GBP]);
        });

        it('falls back to [defaultCurrencyCode] when indexCurrencyCode is enabled but availableCurrencyCodes is undefined', () => {
            const channel = new Channel({
                defaultCurrencyCode: CurrencyCode.GBP,
            } as Partial<Channel>);
            expect(resolveChannelIndexCurrencies(true, channel)).toEqual([CurrencyCode.GBP]);
        });
    });
});
