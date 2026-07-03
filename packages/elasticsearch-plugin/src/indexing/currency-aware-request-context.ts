import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { Channel, MutableRequestContext } from '@vendure/core';

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

    /**
     * We deliberately reimplement `deserialize` instead of delegating to
     * `super.deserialize` + `Object.setPrototypeOf`. The previous prototype-swap
     * trick worked but (a) reads as voodoo at the call site, (b) triggers V8
     * mega-morphic deopts on hot indexing paths and (c) silently breaks if core
     * ever moves `RequestContext`'s internal state to private `#` fields, which
     * cannot be re-parented via `setPrototypeOf`.
     *
     * The body mirrors {@link MutableRequestContext.deserialize} exactly — same
     * field plumbing, same session/date rehydration — so subclass semantics stay
     * in lockstep with the upstream contract. If core's `deserialize` shape
     * changes (e.g. a new field on the constructor options), this method needs
     * to track that change.
     */
    static deserialize(ctxObject: SerializedCtx): CurrencyAwareMutableRequestContext {
        return new CurrencyAwareMutableRequestContext({
            req: ctxObject._req,
            apiType: ctxObject._apiType,
            channel: new Channel(ctxObject._channel),
            session: {
                ...ctxObject._session,
                expires: ctxObject._session?.expires && new Date(ctxObject._session.expires),
            },
            languageCode: ctxObject._languageCode,
            isAuthorized: ctxObject._isAuthorized,
            authorizedAsOwnerOnly: ctxObject._authorizedAsOwnerOnly,
        });
    }
}
