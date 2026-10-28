import { Channel, Logger, Product, ProductVariant, RequestContext } from '@vendure/core';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VARIANT_INDEX_NAME } from '../constants';

import { ElasticsearchIndexerController } from './indexer.controller';

/**
 * Unit tests for the pre-enqueue stock guard (`stockMovementWouldChangeIndex`), which is scoped to
 * the moved variants only. See vendurehq/community-plugins#51.
 */

type IndexedDoc = { productVariantId: string | number; channelId: string | number; inStock: unknown };

interface Setup {
    /** The variant "table": the moved-variant load returns the rows whose id is requested. */
    loaded?: ProductVariant[];
    /** Documents returned by the index search. */
    indexed?: IndexedDoc[];
    /** Saleable stock level per `${variantId}:${channelId}`. */
    saleable?: Record<string, number>;
    options?: Record<string, unknown>;
    searchError?: Error;
}

function channel(id: number): Channel {
    return new Channel({ id, code: `channel-${id}`, token: `token-${id}` });
}

function variant(id: number, channels: Channel[], extra: Partial<ProductVariant> = {}): ProductVariant {
    return new ProductVariant({ id, channels, deletedAt: null, enabled: true, ...extra });
}

function createGuard(setup: Setup) {
    const repository = {
        find: vi.fn((args: any) => {
            const requested = new Set<string>((args.where.id.value as any[]).map(String));
            return Promise.resolve((setup.loaded ?? []).filter(v => requested.has(String(v.id))));
        }),
    };
    const connection: any = {
        getRepository: vi.fn(() => repository),
    };
    const adapter: any = {
        search: vi.fn(() => {
            if (setup.searchError) {
                return Promise.reject(setup.searchError);
            }
            return Promise.resolve({
                body: { hits: { hits: (setup.indexed ?? []).map(doc => ({ _source: doc })) } },
            });
        }),
        close: vi.fn(),
    };
    const saleableCalls: Array<{ variantId: string; channelId: string }> = [];
    const productVariantService: any = {
        getSaleableStockLevel: vi.fn((ctx: RequestContext, v: ProductVariant) => {
            const key = `${String(v.id)}:${String(ctx.channelId)}`;
            saleableCalls.push({ variantId: String(v.id), channelId: String(ctx.channelId) });
            return Promise.resolve(setup.saleable?.[key] ?? 0);
        }),
    };
    const options: any = {
        indexPrefix: 'test-',
        reindexOnStockMovement: 'onStockStatusChange',
        customProductMappings: {},
        customProductVariantMappings: {},
        hydrateProductRelations: [],
        hydrateProductVariantRelations: [],
        adapter: () => adapter,
        ...setup.options,
    };
    const controller = new ElasticsearchIndexerController(
        connection,
        options,
        {} as any,
        {} as any,
        productVariantService,
        {} as any,
        {} as any,
    );
    controller.onModuleInit();
    return { controller, connection, repository, adapter, productVariantService, saleableCalls };
}

function ctxFor(ch: Channel): RequestContext {
    return new RequestContext({
        apiType: 'admin',
        channel: ch,
        isAuthorized: true,
        authorizedAsOwnerOnly: false,
    });
}

describe('ElasticsearchIndexerController.stockMovementWouldChangeIndex()', () => {
    const defaultChannel = channel(1);
    const secondChannel = channel(2);

    let warnSpy: MockInstance;

    beforeEach(() => {
        warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns false when the moved variant does not flip (50 to 49)', async () => {
        const moved = variant(10, [defaultChannel]);
        const { controller } = createGuard({
            loaded: [moved],
            indexed: [{ productVariantId: '10', channelId: '1', inStock: true }],
            saleable: { '10:1': 49 },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(false);
    });

    it('returns true when the moved variant flips out of stock', async () => {
        const moved = variant(10, [defaultChannel]);
        const { controller } = createGuard({
            loaded: [moved],
            indexed: [{ productVariantId: '10', channelId: '1', inStock: true }],
            saleable: { '10:1': 0 },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(true);
    });

    it('returns true when the moved variant flips back in stock', async () => {
        const moved = variant(10, [defaultChannel]);
        const { controller } = createGuard({
            loaded: [moved],
            indexed: [{ productVariantId: '10', channelId: '1', inStock: false }],
            saleable: { '10:1': 3 },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(true);
    });

    it('returns true when a moved variant has no indexed document', async () => {
        const indexedVariant = variant(10, [defaultChannel]);
        const unindexedVariant = variant(11, [defaultChannel]);
        const { controller } = createGuard({
            loaded: [indexedVariant, unindexedVariant],
            indexed: [{ productVariantId: '10', channelId: '1', inStock: true }],
            saleable: { '10:1': 5, '11:1': 5 },
        });
        expect(
            await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [
                indexedVariant,
                unindexedVariant,
            ]),
        ).toBe(true);
    });

    it('returns true when only one of several channels flips', async () => {
        const moved = variant(10, [defaultChannel, secondChannel]);
        const { controller, saleableCalls } = createGuard({
            loaded: [moved],
            indexed: [
                { productVariantId: '10', channelId: '1', inStock: true },
                { productVariantId: '10', channelId: '2', inStock: true },
            ],
            saleable: { '10:1': 5, '10:2': 0 },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(true);
        // Each channel is evaluated under its own channel on the context.
        expect(saleableCalls).toEqual([
            { variantId: '10', channelId: '1' },
            { variantId: '10', channelId: '2' },
        ]);
    });

    it('returns false when no channel flips, evaluating every channel and language', async () => {
        const moved = variant(10, [defaultChannel, secondChannel]);
        const { controller, saleableCalls } = createGuard({
            loaded: [moved],
            indexed: [
                { productVariantId: '10', channelId: '1', inStock: true },
                { productVariantId: '10', channelId: '1', inStock: true },
                { productVariantId: '10', channelId: '2', inStock: false },
            ],
            saleable: { '10:1': 5, '10:2': 0 },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(false);
        // Two language documents in channel 1 still cost a single stock lookup there.
        expect(saleableCalls).toHaveLength(2);
    });

    it('returns true when language documents for one pair disagree', async () => {
        const moved = variant(10, [defaultChannel]);
        const { controller } = createGuard({
            loaded: [moved],
            indexed: [
                { productVariantId: '10', channelId: '1', inStock: true },
                { productVariantId: '10', channelId: '1', inStock: false },
            ],
            saleable: { '10:1': 5 },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(true);
    });

    it('returns true when the indexed inStock is not a boolean', async () => {
        const moved = variant(10, [defaultChannel]);
        const { controller } = createGuard({
            loaded: [moved],
            indexed: [{ productVariantId: '10', channelId: '1', inStock: undefined }],
            saleable: { '10:1': 0 },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(true);
    });

    it('returns true when a document exists for a channel the variant is no longer in', async () => {
        const moved = variant(10, [defaultChannel]);
        const { controller } = createGuard({
            loaded: [moved],
            indexed: [
                { productVariantId: '10', channelId: '1', inStock: true },
                { productVariantId: '10', channelId: '2', inStock: true },
            ],
            saleable: { '10:1': 5 },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(true);
    });

    it('returns true when the search result may be truncated', async () => {
        const moved = variant(10, [defaultChannel]);
        const indexed = Array.from({ length: 10_000 }, () => ({
            productVariantId: '10',
            channelId: '1',
            inStock: true,
        }));
        const { controller, productVariantService } = createGuard({
            loaded: [moved],
            indexed,
            saleable: { '10:1': 5 },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(true);
        expect(productVariantService.getSaleableStockLevel).not.toHaveBeenCalled();
    });

    it('returns true when a moved variant is soft-deleted', async () => {
        const moved = variant(10, [defaultChannel], { deletedAt: new Date() });
        const { controller, adapter } = createGuard({
            loaded: [moved],
            indexed: [{ productVariantId: '10', channelId: '1', inStock: true }],
            saleable: { '10:1': 5 },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(true);
        expect(adapter.search).not.toHaveBeenCalled();
    });

    it('returns true when a moved variant no longer exists', async () => {
        const moved = variant(10, [defaultChannel]);
        const { controller, adapter } = createGuard({ loaded: [] });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(true);
        expect(adapter.search).not.toHaveBeenCalled();
    });

    it('does not consult enabled flags, matching what the index builder writes for inStock', async () => {
        // createVariantIndexItem writes inStock from the saleable stock level regardless of the
        // variant or product being disabled, so a disabled variant is compared the same way.
        const product = new Product({ id: 1, enabled: false });
        const moved = variant(10, [defaultChannel], { enabled: false, product });
        const { controller } = createGuard({
            loaded: [moved],
            indexed: [{ productVariantId: '10', channelId: '1', inStock: true }],
            saleable: { '10:1': 5 },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(false);
    });

    it('returns true for an empty variant list without querying', async () => {
        const { controller, connection, adapter } = createGuard({});
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [])).toBe(true);
        expect(connection.getRepository).not.toHaveBeenCalled();
        expect(adapter.search).not.toHaveBeenCalled();
    });

    it('returns true when evaluation fails', async () => {
        const moved = variant(10, [defaultChannel]);
        const { controller } = createGuard({
            loaded: [moved],
            searchError: new Error('search unavailable'),
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(true);
        expect(warnSpy).toHaveBeenCalled();
    });

    it("returns true under 'always' without any queries", async () => {
        const moved = variant(10, [defaultChannel]);
        const { controller, connection, adapter, productVariantService } = createGuard({
            loaded: [moved],
            options: { reindexOnStockMovement: 'always' },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(true);
        expect(connection.getRepository).not.toHaveBeenCalled();
        expect(adapter.search).not.toHaveBeenCalled();
        expect(productVariantService.getSaleableStockLevel).not.toHaveBeenCalled();
    });

    it.each([
        [
            'customProductMappings',
            { customProductMappings: { foo: { graphQlType: 'Int', valueFn: () => 1 } } },
        ],
        [
            'customProductVariantMappings',
            { customProductVariantMappings: { foo: { graphQlType: 'Int', valueFn: () => 1 } } },
        ],
    ])('returns true without any queries when %s is configured', async (_name, options) => {
        const moved = variant(10, [defaultChannel]);
        const { controller, connection, adapter, productVariantService } = createGuard({
            loaded: [moved],
            options,
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved])).toBe(true);
        expect(connection.getRepository).not.toHaveBeenCalled();
        expect(adapter.search).not.toHaveBeenCalled();
        expect(productVariantService.getSaleableStockLevel).not.toHaveBeenCalled();
    });

    it('restores the original channel on the context it evaluates with', async () => {
        const moved = variant(10, [defaultChannel, secondChannel]);
        const { controller, productVariantService } = createGuard({
            loaded: [moved],
            indexed: [
                { productVariantId: '10', channelId: '1', inStock: true },
                { productVariantId: '10', channelId: '2', inStock: true },
            ],
            saleable: { '10:1': 5, '10:2': 5 },
        });
        const ctx = ctxFor(defaultChannel);
        await controller.stockMovementWouldChangeIndex(ctx, [moved]);
        // The caller's context is never mutated; the guard works on a deserialized copy.
        expect(ctx.channelId).toBe(1);
        const evaluatedCtx = productVariantService.getSaleableStockLevel.mock.calls[0][0];
        expect(evaluatedCtx).not.toBe(ctx);
        expect(evaluatedCtx.channelId).toBe(1);
    });

    // Regression guard for #51: the guard must stay scoped to the moved variants. It must not load
    // the Product or its sibling variants, and must not compute stock for variants that did not move.
    it('only loads and evaluates the moved variant once per channel, whatever the product size', async () => {
        // A product with 20 variants in two channels, of which only variant 10 moved.
        const product = new Product({ id: 1, enabled: true });
        const siblings = Array.from({ length: 20 }, (_, i) =>
            variant(i + 1, [defaultChannel, secondChannel], { product, productId: 1 } as any),
        );
        const moved = siblings[9];
        const { controller, connection, repository, adapter, saleableCalls } = createGuard({
            loaded: siblings,
            indexed: [
                { productVariantId: '10', channelId: '1', inStock: true },
                { productVariantId: '10', channelId: '2', inStock: true },
            ],
            saleable: { '10:1': 49, '10:2': 49 },
        });
        expect(await controller.stockMovementWouldChangeIndex(ctxFor(defaultChannel), [moved, moved])).toBe(
            false,
        );

        // One repository call, for ProductVariant only (never Product), with no product relations.
        expect(connection.getRepository).toHaveBeenCalledTimes(1);
        expect(connection.getRepository.mock.calls[0][1]).toBe(ProductVariant);
        expect(connection.getRepository.mock.calls.some((call: any[]) => call[1] === Product)).toBe(false);
        expect(repository.find).toHaveBeenCalledTimes(1);
        const findArgs = (repository.find.mock.calls[0] as any[])[0];
        expect(findArgs.relations).toEqual(['channels']);

        // One search, scoped by productVariantId (not productId) to the de-duplicated moved ids.
        expect(adapter.search).toHaveBeenCalledTimes(1);
        const searchArgs = adapter.search.mock.calls[0][0];
        expect(searchArgs.index).toBe('test-' + VARIANT_INDEX_NAME);
        expect(searchArgs.body.query).toEqual({ terms: { productVariantId: [10] } });
        expect(searchArgs.body._source).toEqual(['productVariantId', 'channelId', 'inStock']);

        // Exactly one saleable stock lookup per channel for the moved variant, and nothing else.
        expect(saleableCalls).toEqual([
            { variantId: '10', channelId: '1' },
            { variantId: '10', channelId: '2' },
        ]);
    });
});
