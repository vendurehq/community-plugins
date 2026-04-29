import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { MutableRequestContext } from '@vendure/core';

type SerializedCtx = Parameters<typeof MutableRequestContext.deserialize>[0];

/**
 * Extends MutableRequestContext with the ability to override the currencyCode
 * independently from the channel. Used by the search indexer to iterate over
 * each available currency of a channel without mutating the channel entity.
 */
export class CurrencyAwareMutableRequestContext extends MutableRequestContext {
    private mutatedCurrencyCode?: CurrencyCode;

    setCurrencyCode(currencyCode: CurrencyCode | undefined): void {
        this.mutatedCurrencyCode = currencyCode;
    }

    get currencyCode(): CurrencyCode {
        return this.mutatedCurrencyCode ?? super.currencyCode;
    }

    static deserialize(ctxObject: SerializedCtx): CurrencyAwareMutableRequestContext {
        const base = MutableRequestContext.deserialize(ctxObject);
        return Object.setPrototypeOf(base, CurrencyAwareMutableRequestContext.prototype);
    }
}
