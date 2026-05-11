import type { SearchClientAdapter } from '../adapter';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { unique } from '@vendure/common/lib/unique';
import {
    Asset,
    asyncObservable,
    AsyncQueue,
    Channel,
    Collection,
    ConfigService,
    EntityRelationPaths,
    FacetValue,
    ID,
    Injector,
    InternalServerError,
    LanguageCode,
    Logger,
    Product,
    ProductPriceApplicator,
    ProductVariant,
    ProductVariantService,
    RequestContext,
    RequestContextCacheService,
    TransactionalConnection,
    Translatable,
    Translation,
} from '@vendure/core';
import { Observable } from 'rxjs';
import { In, IsNull } from 'typeorm';

import { ELASTIC_SEARCH_OPTIONS, loggerCtx, VARIANT_INDEX_NAME } from '../constants';
import { ElasticsearchRuntimeOptions } from '../options';
import {
    BulkOperation,
    BulkOperationDoc,
    ProductChannelMessageData,
    ProductIndexItem,
    ReindexMessageData,
    UpdateAssetMessageData,
    UpdateProductMessageData,
    UpdateVariantMessageData,
    UpdateVariantsByIdMessageData,
    VariantChannelMessageData,
    VariantIndexItem,
} from '../types';

import { CurrencyAwareMutableRequestContext } from './currency-aware-request-context';
import { buildVariantDocId, resolveChannelIndexCurrencies } from './indexing-id-helpers';
import { createIndices, getIndexNameByAlias } from './indexing-utils';
import {
    shouldSkipVariantForCurrency,
    snapshotProductPriceAggregates,
    snapshotVariantPrice,
} from './variant-price-utils';

export const defaultProductRelations: Array<EntityRelationPaths<Product>> = [
    'featuredAsset',
    'facetValues',
    'facetValues.facet',
    'channels',
    'channels.defaultTaxZone',
];

export const defaultVariantRelations: Array<EntityRelationPaths<ProductVariant>> = [
    'featuredAsset',
    'facetValues',
    'facetValues.facet',
    'collections',
    'taxCategory',
    'channels',
    'channels.defaultTaxZone',
    'productVariantPrices',
];

export interface ReindexMessageResponse {
    total: number;
    completed: number;
    duration: number;
}

type BulkVariantOperation = {
    index: typeof VARIANT_INDEX_NAME;
    operation: BulkOperation | BulkOperationDoc<VariantIndexItem>;
};

@Injectable()
export class ElasticsearchIndexerController implements OnModuleInit, OnModuleDestroy {
    private adapter!: SearchClientAdapter;
    private asyncQueue = new AsyncQueue('elasticsearch-indexer', 5);
    private productRelations: Array<EntityRelationPaths<Product>>;
    private variantRelations: Array<EntityRelationPaths<ProductVariant>>;
    private injector: Injector;

    constructor(
        private connection: TransactionalConnection,
        @Inject(ELASTIC_SEARCH_OPTIONS) private options: ElasticsearchRuntimeOptions,
        private productPriceApplicator: ProductPriceApplicator,
        private configService: ConfigService,
        private productVariantService: ProductVariantService,
        private requestContextCache: RequestContextCacheService,
        private moduleRef: ModuleRef,
    ) {}

    onModuleInit(): any {
        // Build our own adapter instance from the factory. ElasticsearchService
        // does the same independently, so this controller and the read-side
        // service each own a separate client & connection pool — tearing one
        // down during `onModuleDestroy` does not drain the other.
        this.adapter = this.options.adapter();
        this.productRelations = this.getReindexRelations(
            defaultProductRelations,
            this.options.hydrateProductRelations,
        );
        this.variantRelations = this.getReindexRelations(
            defaultVariantRelations,
            this.options.hydrateProductVariantRelations,
        );
        this.injector = new Injector(this.moduleRef);
    }

    onModuleDestroy(): any {
        return this.adapter.close();
    }

    /**
     * Updates the search index only for the affected product.
     */
    async updateProduct({ ctx: rawContext, productId }: UpdateProductMessageData): Promise<boolean> {
        const ctx = CurrencyAwareMutableRequestContext.deserialize(rawContext);
        await this.updateProductsInternal(ctx, [productId]);
        return true;
    }

    /**
     * Updates the search index only for the affected product.
     */
    async deleteProduct({ ctx: rawContext, productId }: UpdateProductMessageData): Promise<boolean> {
        await this.deleteProductOperations(RequestContext.deserialize(rawContext), productId);
        return true;
    }

    /**
     * Updates the search index only for the affected product.
     */
    async assignProductToChannel({
        ctx: rawContext,
        productId,
        channelId,
    }: ProductChannelMessageData): Promise<boolean> {
        const ctx = CurrencyAwareMutableRequestContext.deserialize(rawContext);
        await this.updateProductsInternal(ctx, [productId]);
        return true;
    }

    /**
     * Updates the search index only for the affected product.
     */
    async removeProductFromChannel({
        ctx: rawContext,
        productId,
        channelId,
    }: ProductChannelMessageData): Promise<boolean> {
        const ctx = CurrencyAwareMutableRequestContext.deserialize(rawContext);
        await this.updateProductsInternal(ctx, [productId]);
        return true;
    }

    async assignVariantToChannel({
        ctx: rawContext,
        productVariantId,
        channelId,
    }: VariantChannelMessageData): Promise<boolean> {
        const productIds = await this.getProductIdsByVariantIds([productVariantId]);
        const ctx = CurrencyAwareMutableRequestContext.deserialize(rawContext);
        await this.updateProductsInternal(ctx, productIds);
        return true;
    }

    async removeVariantFromChannel({
        ctx: rawContext,
        productVariantId,
        channelId,
    }: VariantChannelMessageData): Promise<boolean> {
        const productIds = await this.getProductIdsByVariantIds([productVariantId]);
        const ctx = CurrencyAwareMutableRequestContext.deserialize(rawContext);
        await this.updateProductsInternal(ctx, productIds);
        return true;
    }

    /**
     * Updates the search index only for the affected entities.
     */
    async updateVariants({ ctx: rawContext, variantIds }: UpdateVariantMessageData): Promise<boolean> {
        const ctx = CurrencyAwareMutableRequestContext.deserialize(rawContext);
        return this.asyncQueue.push(async () => {
            const productIds = await this.getProductIdsByVariantIds(variantIds);
            await this.updateProductsInternal(ctx, productIds);
            return true;
        });
    }

    async deleteVariants({ ctx: rawContext, variantIds }: UpdateVariantMessageData): Promise<boolean> {
        const ctx = CurrencyAwareMutableRequestContext.deserialize(rawContext);
        const productIds = await this.getProductIdsByVariantIds(variantIds);
        for (const productId of productIds) {
            await this.updateProductsInternal(ctx, [productId]);
        }
        return true;
    }

    updateVariantsById({
        ctx: rawContext,
        ids,
    }: UpdateVariantsByIdMessageData): Observable<ReindexMessageResponse> {
        const ctx = CurrencyAwareMutableRequestContext.deserialize(rawContext);
        return asyncObservable(async observer => {
            return this.asyncQueue.push(async () => {
                const timeStart = Date.now();
                const productIds = await this.getProductIdsByVariantIds(ids);
                if (productIds.length) {
                    let finishedProductsCount = 0;
                    for (const productId of productIds) {
                        await this.updateProductsInternal(ctx, [productId]);
                        finishedProductsCount++;
                        observer.next({
                            total: productIds.length,
                            completed: Math.min(finishedProductsCount, productIds.length),
                            duration: +new Date() - timeStart,
                        });
                    }
                }
                Logger.verbose('Completed updating variants', loggerCtx);
                return {
                    total: productIds.length,
                    completed: productIds.length,
                    duration: +new Date() - timeStart,
                };
            });
        });
    }

    reindex({ ctx: rawContext }: ReindexMessageData): Observable<ReindexMessageResponse> {
        return asyncObservable(async observer => {
            return this.asyncQueue.push(async () => {
                const timeStart = Date.now();
                const ctx = CurrencyAwareMutableRequestContext.deserialize(rawContext);

                const reindexTempName = new Date().getTime();
                const variantIndexName = `${this.options.indexPrefix}${VARIANT_INDEX_NAME}`;
                const variantIndexNameForReindex = `${VARIANT_INDEX_NAME}-reindex-${reindexTempName}`;
                const reindexVariantAliasName = `${this.options.indexPrefix}${variantIndexNameForReindex}`;
                try {
                    await createIndices(
                        this.adapter,
                        this.options.indexPrefix,
                        this.options.indexSettings,
                        this.options.indexMappingProperties,
                        true,
                        `-reindex-${reindexTempName}`,
                    );
                } catch (e: any) {
                    Logger.error('Could not recreate indices.', loggerCtx);
                    Logger.error(JSON.stringify(e), loggerCtx);
                    throw e;
                }

                const totalProductIds = await this.connection.rawConnection
                    .getRepository(Product)
                    .createQueryBuilder('product')
                    .where('product.deletedAt IS NULL')
                    .getCount();

                Logger.verbose(`Will reindex ${totalProductIds} products`, loggerCtx);

                let productIds = [];
                let skip = 0;
                let finishedProductsCount = 0;
                do {
                    productIds = await this.connection.rawConnection
                        .getRepository(Product)
                        .createQueryBuilder('product')
                        .select('product.id')
                        .where('product.deletedAt IS NULL')
                        .skip(skip)
                        .take(this.options.reindexProductsChunkSize)
                        .getMany();

                    for (const { id: productId } of productIds) {
                        await this.updateProductsOperationsOnly(ctx, productId, variantIndexNameForReindex);
                        finishedProductsCount++;
                        observer.next({
                            total: totalProductIds,
                            completed: Math.min(finishedProductsCount, totalProductIds),
                            duration: +new Date() - timeStart,
                        });
                    }

                    skip += this.options.reindexProductsChunkSize;

                    Logger.verbose(`Done ${finishedProductsCount} / ${totalProductIds} products`);
                } while (productIds.length >= this.options.reindexProductsChunkSize);

                // Switch the index to the new reindexed one
                await this.switchAlias(reindexVariantAliasName, variantIndexName);

                Logger.verbose('Completed reindexing!', loggerCtx);

                return {
                    total: totalProductIds,
                    completed: totalProductIds,
                    duration: +new Date() - timeStart,
                };
            });
        });
    }

    async executeBulkOperationsByChunks(
        chunkSize: number,
        operations: BulkVariantOperation[],
        index = VARIANT_INDEX_NAME,
    ): Promise<void> {
        Logger.verbose(
            `Will execute ${operations.length} bulk update operations with index ${index}`,
            loggerCtx,
        );
        let i;
        let j;
        let processedOperation = 0;
        for (i = 0, j = operations.length; i < j; i += chunkSize) {
            const operationsChunks = operations.slice(i, i + chunkSize);
            await this.executeBulkOperations(operationsChunks, index);
            processedOperation += operationsChunks.length;

            Logger.verbose(
                `Executing operation chunks ${processedOperation}/${operations.length}`,
                loggerCtx,
            );
        }
    }

    async updateAsset(data: UpdateAssetMessageData): Promise<boolean> {
        const result = await this.updateAssetFocalPointForIndex(VARIANT_INDEX_NAME, data.asset);
        await this.adapter.indices.refresh({
            index: [this.options.indexPrefix + VARIANT_INDEX_NAME],
        });
        return result;
    }

    async deleteAsset(data: UpdateAssetMessageData): Promise<boolean> {
        const result = await this.deleteAssetForIndex(VARIANT_INDEX_NAME, data.asset);
        await this.adapter.indices.refresh({
            index: [this.options.indexPrefix + VARIANT_INDEX_NAME],
        });
        return result;
    }

    private async updateAssetFocalPointForIndex(indexName: string, asset: Asset): Promise<boolean> {
        const focalPoint = asset.focalPoint || null;
        const params = { focalPoint };
        return this.updateAssetForIndex(
            indexName,
            asset,
            {
                source: 'ctx._source.productPreviewFocalPoint = params.focalPoint',
                params,
            },
            {
                source: 'ctx._source.productVariantPreviewFocalPoint = params.focalPoint',
                params,
            },
        );
    }

    private async deleteAssetForIndex(indexName: string, asset: Asset): Promise<boolean> {
        return this.updateAssetForIndex(
            indexName,
            asset,
            { source: 'ctx._source.productAssetId = null' },
            { source: 'ctx._source.productVariantAssetId = null' },
        );
    }

    private async updateAssetForIndex(
        indexName: string,
        asset: Asset,
        updateProductScript: { source: string; params?: any },
        updateVariantScript: { source: string; params?: any },
    ): Promise<boolean> {
        const result1 = await this.adapter.updateByQuery({
            index: this.options.indexPrefix + indexName,
            body: {
                script: updateProductScript,
                query: {
                    term: {
                        productAssetId: asset.id,
                    },
                },
            },
        });

        if (result1.body.failures) {
            for (const failure of result1.body.failures) {
                Logger.error(`${failure.cause.type}: ${failure.cause.reason}`, loggerCtx);
            }
        }

        const result2 = await this.adapter.updateByQuery({
            index: this.options.indexPrefix + indexName,
            body: {
                script: updateVariantScript,
                query: {
                    term: {
                        productVariantAssetId: asset.id,
                    },
                },
            },
        });

        if (result2.body.failures) {
            for (const failure of result2.body.failures) {
                Logger.error(`${failure.cause.type}: ${failure.cause.reason}`, loggerCtx);
            }
        }

        const failures1 = result1.body.failures ?? [];
        const failures2 = result2.body.failures ?? [];
        return failures1.length === 0 && failures2.length === 0;
    }

    private async updateProductsInternal(ctx: CurrencyAwareMutableRequestContext, productIds: ID[]) {
        await this.updateProductsOperations(ctx, productIds);
    }

    private async switchAlias(reindexVariantAliasName: string, variantIndexName: string): Promise<void> {
        try {
            const reindexVariantAliasExist = await this.adapter.indices.existsAlias({
                name: reindexVariantAliasName,
            });
            if (reindexVariantAliasExist.body) {
                const reindexVariantIndexName = await getIndexNameByAlias(
                    this.adapter,
                    reindexVariantAliasName,
                );
                const originalVariantAliasExist = await this.adapter.indices.existsAlias({
                    name: variantIndexName,
                });
                const originalVariantIndexExist = await this.adapter.indices.exists({
                    index: variantIndexName,
                });

                const originalVariantIndexName = await getIndexNameByAlias(this.adapter, variantIndexName);

                const actions = [
                    {
                        remove: {
                            index: reindexVariantIndexName,
                            alias: reindexVariantAliasName,
                        },
                    },
                    {
                        add: {
                            index: reindexVariantIndexName,
                            alias: variantIndexName,
                        },
                    },
                ];

                if (originalVariantAliasExist.body) {
                    actions.push({
                        remove: {
                            index: originalVariantIndexName,
                            alias: variantIndexName,
                        },
                    });
                } else if (originalVariantIndexExist.body) {
                    await this.adapter.indices.delete({
                        index: [variantIndexName],
                    });
                }

                await this.adapter.indices.updateAliases({
                    body: { actions },
                });

                if (originalVariantAliasExist.body && originalVariantIndexName) {
                    await this.adapter.indices.delete({
                        index: [originalVariantIndexName],
                    });
                }
            }
        } catch (e: any) {
            Logger.error('Could not switch indexes');
        } finally {
            const reindexVariantAliasExist = await this.adapter.indices.existsAlias({
                name: reindexVariantAliasName,
            });
            if (reindexVariantAliasExist.body) {
                const reindexVariantAliasResult = await this.adapter.indices.getAlias({
                    name: reindexVariantAliasName,
                });
                const reindexVariantIndexName = Object.keys(reindexVariantAliasResult.body)[0];
                await this.adapter.indices.delete({
                    index: [reindexVariantIndexName],
                });
            }
        }
    }

    private async updateProductsOperationsOnly(
        ctx: CurrencyAwareMutableRequestContext,
        productId: ID,
        index = VARIANT_INDEX_NAME,
    ): Promise<void> {
        let operations: BulkVariantOperation[] = [];
        let product: Product | undefined;
        try {
            product = await this.connection
                .getRepository(ctx, Product)
                .find({
                    where: { id: productId, deletedAt: IsNull() },
                    relations: this.productRelations,
                })
                .then(result => result[0] ?? undefined);
        } catch (e: any) {
            Logger.error(e.message, loggerCtx, e.stack);
            throw e;
        }
        if (!product) {
            return;
        }
        let updatedProductVariants: ProductVariant[] = [];
        try {
            updatedProductVariants = await this.connection.rawConnection.getRepository(ProductVariant).find({
                relations: this.variantRelations,
                where: {
                    productId,
                    deletedAt: IsNull(),
                },
                order: {
                    id: 'ASC',
                },
            });
        } catch (e: any) {
            Logger.error(e.message, loggerCtx, e.stack);
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        updatedProductVariants.forEach(variant => (variant.product = product!));
        if (!product.enabled) {
            updatedProductVariants.forEach(v => (v.enabled = false));
        }

        Logger.debug(`Updating Product (${productId})`, loggerCtx);
        const languageVariants: LanguageCode[] = [];
        languageVariants.push(...product.translations.map(t => t.languageCode));
        for (const variant of updatedProductVariants)
            languageVariants.push(...variant.translations.map(t => t.languageCode));

        const uniqueLanguageVariants = unique(languageVariants);
        const originalChannel = ctx.channel;
        // The same `ctx` instance is reused across products in `updateProductsOperations`,
        // so any exception inside the per-channel/per-currency loop must NOT leak a
        // stale `mutatedCurrencyCode` or `channel` onto the shared context. `finally`
        // guarantees the resets run even on the throwing path.
        try {
            for (const channel of product.channels) {
                ctx.setChannel(channel);
                const variantsInChannel = updatedProductVariants.filter(v =>
                    v.channels.map(c => c.id).includes(ctx.channelId),
                );

                const currencyCodes = this.getChannelIndexCurrencies(channel);

                for (const currencyCode of currencyCodes) {
                    ctx.setCurrencyCode(currencyCode);

                    for (const variant of variantsInChannel)
                        await this.productPriceApplicator.applyChannelPriceAndTax(variant, ctx);

                    for (const languageCode of uniqueLanguageVariants) {
                        if (variantsInChannel.length) {
                            for (const variant of variantsInChannel) {
                                // Skip variants with no explicit ProductVariantPrice in the
                                // current (channel, currency) pair: without this guard,
                                // applyChannelPriceAndTax falls back to a zero `listPrice` and we
                                // would index a phantom `price: 0` document that pollutes
                                // `sort: { price: ASC }` and surfaces unpriced variants in
                                // currency-filtered searches.
                                if (shouldSkipVariantForCurrency(variant, ctx.channelId, currencyCode)) {
                                    Logger.debug(
                                        `Skipping variant ${variant.id} for ${currencyCode}: no ProductVariantPrice in this channel`,
                                        loggerCtx,
                                    );
                                    continue;
                                }
                                operations.push(
                                    {
                                        index: VARIANT_INDEX_NAME,
                                        operation: {
                                            update: {
                                                _id: this.getId(
                                                    variant.id,
                                                    ctx.channelId,
                                                    languageCode,
                                                    currencyCode,
                                                ),
                                            },
                                        },
                                    },
                                    {
                                        index: VARIANT_INDEX_NAME,
                                        operation: {
                                            doc: await this.createVariantIndexItem(
                                                variant,
                                                variantsInChannel,
                                                ctx,
                                                languageCode,
                                            ),
                                            doc_as_upsert: true,
                                        },
                                    },
                                );

                                if (operations.length >= this.options.reindexBulkOperationSizeLimit) {
                                    // Because we can have a huge amount of variant for 1 product, we also chunk update operations
                                    await this.executeBulkOperationsByChunks(
                                        this.options.reindexBulkOperationSizeLimit,
                                        operations,
                                        index,
                                    );
                                    operations = [];
                                }
                            }
                        } else {
                            operations.push(
                                {
                                    index: VARIANT_INDEX_NAME,
                                    operation: {
                                        update: {
                                            _id: this.getId(
                                                -product.id,
                                                ctx.channelId,
                                                languageCode,
                                                currencyCode,
                                            ),
                                        },
                                    },
                                },
                                {
                                    index: VARIANT_INDEX_NAME,
                                    operation: {
                                        doc: await this.createSyntheticProductIndexItem(
                                            product,
                                            ctx,
                                            languageCode,
                                        ),
                                        doc_as_upsert: true,
                                    },
                                },
                            );
                        }
                        if (operations.length >= this.options.reindexBulkOperationSizeLimit) {
                            // Because we can have a huge amount of variant for 1 product, we also chunk update operations
                            await this.executeBulkOperationsByChunks(
                                this.options.reindexBulkOperationSizeLimit,
                                operations,
                                index,
                            );
                            operations = [];
                        }
                    }
                }
            }
        } finally {
            ctx.setCurrencyCode(undefined);
            ctx.setChannel(originalChannel);
        }

        // Because we can have a huge amount of variant for 1 product, we also chunk update operations
        await this.executeBulkOperationsByChunks(
            this.options.reindexBulkOperationSizeLimit,
            operations,
            index,
        );

        return;
    }

    private async updateProductsOperations(ctx: CurrencyAwareMutableRequestContext, productIds: ID[]): Promise<void> {
        Logger.debug(`Updating ${productIds.length} Products`, loggerCtx);
        for (const productId of productIds) {
            await this.deleteProductOperations(ctx, productId);
            await this.updateProductsOperationsOnly(ctx, productId);
        }
        return;
    }

    /**
     * Takes the default relations, and combines them with any extra relations specified in the
     * `hydrateProductRelations` and `hydrateProductVariantRelations`. This method also ensures
     * that the relation values are unique and that paths are fully expanded.
     *
     * This means that if a `hydrateProductRelations` value of `['assets.asset']` is specified,
     * this method will also add `['assets']` to the relations array, otherwise TypeORM would
     * throw an error trying to join a 2nd-level deep relation without the first level also
     * being joined.
     */
    private getReindexRelations<T extends Product | ProductVariant>(
        defaultRelations: Array<EntityRelationPaths<T>>,
        hydratedRelations: Array<EntityRelationPaths<T>>,
    ): Array<EntityRelationPaths<T>> {
        const uniqueRelations = unique([...defaultRelations, ...hydratedRelations]);
        for (const relation of hydratedRelations) {
            let path = relation.split('.');
            if (path[0] === 'customFields') {
                if (path.length > 2) {
                    throw new InternalServerError(
                        [
                            'hydrateProductRelations / hydrateProductVariantRelations does not currently support nested custom field relations',
                            `Received: "${relation}"`,
                        ].join('\n'),
                    );
                }
                path = [path.join('.')];
            }
            const pathToPart: string[] = [];
            for (const part of path) {
                pathToPart.push(part);
                const joinedPath = pathToPart.join('.') as EntityRelationPaths<T>;
                if (!uniqueRelations.includes(joinedPath)) {
                    uniqueRelations.push(joinedPath);
                }
            }
        }
        return uniqueRelations;
    }

    private async deleteProductOperations(
        ctx: RequestContext,
        productId: ID,
        index: string = VARIANT_INDEX_NAME,
    ): Promise<void> {
        const channels = await this.requestContextCache.get(ctx, 'elastic-index-all-channels', () =>
            this.connection.rawConnection
                .getRepository(Channel)
                .createQueryBuilder('channel')
                .select(['channel.id', 'channel.defaultCurrencyCode', 'channel.availableCurrencyCodes'])
                .getMany(),
        );

        const product = await this.connection
            .getRepository(ctx, Product)
            .createQueryBuilder('product')
            .select(['product.id', 'productVariant.id'])
            .leftJoin('product.variants', 'productVariant')
            .leftJoin('product.channels', 'channel')
            .where('product.id = :productId', { productId })
            .andWhere('channel.id = :channelId', { channelId: ctx.channelId })
            .getOne();

        if (!product) return;

        Logger.debug(`Deleting 1 Product (id: ${productId})`, loggerCtx);

        // Synthetic-product docs (created via createSyntheticProductIndexItem for
        // products with no variants) are stored with `productVariantId: 0` and the
        // owning `productId`. A single delete_by_query per channel removes every
        // synthetic doc — across all currencies and languages — without enumerating
        // the channel's *current* availableCurrencyCodes. That matters because the
        // channel's currency set may have shrunk since indexing, which would
        // otherwise leave orphaned docs for the dropped currencies.
        for (const channel of channels) {
            await this.deleteSyntheticDocsForProductInChannel(channel.id, product.id, index);
        }

        await this.deleteVariantsInternalOperations(product.variants, channels, index);

        return;
    }

    private async deleteVariantsInternalOperations(
        variants: ProductVariant[],
        channels: Channel[],
        index = VARIANT_INDEX_NAME,
    ): Promise<void> {
        if (!variants.length) return;
        Logger.debug(`Deleting ${variants.length} ProductVariants`, loggerCtx);
        // Because we can have a huge amount of variants for 1 product, we chunk
        // the variant id list to keep each delete_by_query body bounded — the
        // chunk size mirrors the same threshold used for indexing bulk ops.
        const chunkSize = this.options.reindexBulkOperationSizeLimit;
        const variantIds = variants.map(v => v.id);
        for (const channel of channels) {
            for (let i = 0; i < variantIds.length; i += chunkSize) {
                const chunk = variantIds.slice(i, i + chunkSize);
                await this.deleteVariantDocsInChannel(channel.id, chunk, index);
            }
        }
        return;
    }

    /**
     * Removes every (currency × language) doc keyed under the given variants in
     * the supplied channel via a single `delete_by_query`. Replaces the previous
     * per-channel/per-currency/per-language bulk-delete fan-out, which would miss
     * docs whose currency had since been removed from the channel's
     * `availableCurrencyCodes`.
     */
    private async deleteVariantDocsInChannel(
        channelId: ID,
        variantIds: ID[],
        index: string,
    ): Promise<void> {
        if (!variantIds.length) return;
        const fullIndexName = this.options.indexPrefix + index;
        try {
            await this.adapter.deleteByQuery({
                index: fullIndexName,
                refresh: true,
                body: {
                    query: {
                        bool: {
                            filter: [
                                { term: { channelId } },
                                { terms: { productVariantId: variantIds } },
                            ],
                        },
                    },
                },
            });
        } catch (e: any) {
            Logger.error(
                `Error deleting variants [${variantIds.join(', ')}] from channel ${channelId} on index ${fullIndexName}: ${JSON.stringify(e?.body?.error ?? e)}`,
                loggerCtx,
            );
        }
    }

    /**
     * Removes the synthetic doc(s) for a product in a channel — the docs created
     * for products with no variants (see `createSyntheticProductIndexItem`). They
     * are identifiable by `productVariantId: 0` alongside the owning `productId`.
     */
    private async deleteSyntheticDocsForProductInChannel(
        channelId: ID,
        productId: ID,
        index: string,
    ): Promise<void> {
        const fullIndexName = this.options.indexPrefix + index;
        try {
            await this.adapter.deleteByQuery({
                index: fullIndexName,
                refresh: true,
                body: {
                    query: {
                        bool: {
                            filter: [
                                { term: { channelId } },
                                { term: { productId } },
                                // Synthetic items are the only docs with productVariantId: 0.
                                { term: { productVariantId: 0 } },
                            ],
                        },
                    },
                },
            });
        } catch (e: any) {
            Logger.error(
                `Error deleting synthetic docs for product ${productId} from channel ${channelId} on index ${fullIndexName}: ${JSON.stringify(e?.body?.error ?? e)}`,
                loggerCtx,
            );
        }
    }

    private async getProductIdsByVariantIds(variantIds: ID[]): Promise<ID[]> {
        const variants = await this.connection.getRepository(ProductVariant).find({
            where: { id: In(variantIds) },
            relations: ['product'],
            loadEagerRelations: false,
        });
        return unique(variants.map(v => v.product.id));
    }

    private async executeBulkOperations(operations: BulkVariantOperation[], indexName = VARIANT_INDEX_NAME) {
        const variantOperations: Array<BulkOperation | BulkOperationDoc<VariantIndexItem>> = [];

        for (const operation of operations) {
            variantOperations.push(operation.operation);
        }

        return Promise.all([this.runBulkOperationsOnIndex(indexName, variantOperations)]);
    }

    private async runBulkOperationsOnIndex(
        indexName: string,
        operations: Array<BulkOperation | BulkOperationDoc<VariantIndexItem | ProductIndexItem>>,
    ) {
        if (operations.length === 0) {
            return;
        }
        try {
            const fullIndexName = this.options.indexPrefix + indexName;
            const { body } = await this.adapter.bulk({
                refresh: true,
                index: fullIndexName,
                body: operations,
            });

            if (body.errors) {
                Logger.error(
                    `Some errors occurred running bulk operations on ${fullIndexName}! Set logger to "debug" to print all errors.`,
                    loggerCtx,
                );
                body.items.forEach(item => {
                    if (item.index) {
                        Logger.debug(JSON.stringify(item.index.error, null, 2), loggerCtx);
                    }
                    if (item.update) {
                        Logger.debug(JSON.stringify(item.update.error, null, 2), loggerCtx);
                    }
                    if (item.delete) {
                        Logger.debug(JSON.stringify(item.delete.error, null, 2), loggerCtx);
                    }
                });
            } else {
                Logger.debug(
                    `Executed ${body.items.length} bulk operations on index [${fullIndexName}]`,
                    loggerCtx,
                );
            }
            return body;
        } catch (e: any) {
            Logger.error(`Error when attempting to run bulk operations [${JSON.stringify(e)}]`, loggerCtx);
            Logger.error('Error details: ' + JSON.stringify(e.body?.error, null, 2), loggerCtx);
        }
    }

    private async createVariantIndexItem(
        v: ProductVariant,
        variants: ProductVariant[],
        ctx: RequestContext,
        languageCode: LanguageCode,
    ): Promise<VariantIndexItem> {
        try {
            // Pin the variant + product price aggregates upfront. `applyChannelPriceAndTax`
            // mutates the same variant instances in place across (channel, currency)
            // iterations in `updateProductsOperationsOnly`; snapshotting before any
            // awaitable work ensures the produced index item reflects the state at
            // entry, even if a future refactor defers bulk-op composition.
            const variantSnapshot = snapshotVariantPrice(v);
            const productPriceSnapshot = snapshotProductPriceAggregates(variants);

            const productAsset = v.product.featuredAsset;
            const variantAsset = v.featuredAsset;
            const productTranslation = this.getTranslation(v.product, languageCode);
            const variantTranslation = this.getTranslation(v, languageCode);
            const collectionTranslations = v.collections.map(c => this.getTranslation(c, languageCode));

            const productCollectionTranslations = variants.reduce(
                (translations, variant) => [
                    ...translations,
                    ...variant.collections.map(c => this.getTranslation(c, languageCode)),
                ],
                [] as Array<Translation<Collection>>,
            );

            const item: VariantIndexItem = {
                channelId: ctx.channelId,
                languageCode,
                productVariantId: v.id,
                sku: v.sku,
                slug: productTranslation.slug,
                productId: v.product.id,
                productName: productTranslation.name,
                productAssetId: productAsset ? productAsset.id : undefined,
                productPreview: productAsset ? productAsset.preview : '',
                productPreviewFocalPoint: productAsset ? productAsset.focalPoint || undefined : undefined,
                productVariantName: variantTranslation.name,
                productVariantAssetId: variantAsset ? variantAsset.id : undefined,
                productVariantPreview: variantAsset ? variantAsset.preview : '',
                productVariantPreviewFocalPoint: variantAsset
                    ? variantAsset.focalPoint || undefined
                    : undefined,
                price: variantSnapshot.price,
                priceWithTax: variantSnapshot.priceWithTax,
                currencyCode: variantSnapshot.currencyCode,
                description: productTranslation.description,
                facetIds: this.getFacetIds([v]),
                channelIds: v.channels.map(c => c.id),
                facetValueIds: this.getFacetValueIds([v]),
                collectionIds: v.collections.map(c => c.id.toString()),
                collectionSlugs: collectionTranslations.map(c => c.slug),
                enabled: v.enabled && v.product.enabled,
                productEnabled: variants.some(variant => variant.enabled) && v.product.enabled,
                productPriceMin: Math.min(...productPriceSnapshot.prices),
                productPriceMax: Math.max(...productPriceSnapshot.prices),
                productPriceWithTaxMin: Math.min(...productPriceSnapshot.pricesWithTax),
                productPriceWithTaxMax: Math.max(...productPriceSnapshot.pricesWithTax),
                productFacetIds: this.getFacetIds(variants),
                productFacetValueIds: this.getFacetValueIds(variants),
                productCollectionIds: unique(
                    variants.reduce(
                        (ids, variant) => [...ids, ...variant.collections.map(c => c.id)],
                        [] as ID[],
                    ),
                ),
                productCollectionSlugs: unique(productCollectionTranslations.map(c => c.slug)),
                productChannelIds: v.product.channels.map(c => c.id),
                inStock: 0 < (await this.productVariantService.getSaleableStockLevel(ctx, v)),
                productInStock: await this.getProductInStockValue(ctx, variants),
            };
            const variantCustomMappings = Object.entries(this.options.customProductVariantMappings);
            for (const [name, def] of variantCustomMappings) {
                item[`variant-${name}`] = await def.valueFn(v, languageCode, this.injector, ctx);
            }

            const productCustomMappings = Object.entries(this.options.customProductMappings);
            for (const [name, def] of productCustomMappings) {
                item[`product-${name}`] = await def.valueFn(
                    v.product,
                    variants,
                    languageCode,
                    this.injector,
                    ctx,
                );
            }
            return item;
        } catch (err: any) {
            Logger.error(err.toString());
            throw Error('Error while reindexing!');
        }
    }

    private async getProductInStockValue(ctx: RequestContext, variants: ProductVariant[]): Promise<boolean> {
        return this.requestContextCache.get(
            ctx,
            `elastic-index-product-in-stock-${ctx.channelId}-${variants.map(v => v.id).join(',')}`,
            async () => {
                const stockLevels = await Promise.all(
                    variants.map(variant => this.productVariantService.getSaleableStockLevel(ctx, variant)),
                );
                return stockLevels.some(stockLevel => 0 < stockLevel);
            },
        );
    }

    /**
     * If a Product has no variants, we create a synthetic variant for the purposes
     * of making that product visible via the search query.
     */
    private async createSyntheticProductIndexItem(
        product: Product,
        ctx: RequestContext,
        languageCode: LanguageCode,
    ): Promise<VariantIndexItem> {
        const productTranslation = this.getTranslation(product, languageCode);
        const productAsset = product.featuredAsset;

        const item: VariantIndexItem = {
            channelId: ctx.channelId,
            languageCode,
            productVariantId: 0,
            sku: '',
            slug: productTranslation.slug,
            productId: product.id,
            productName: productTranslation.name,
            productAssetId: productAsset ? productAsset.id : undefined,
            productPreview: productAsset ? productAsset.preview : '',
            productPreviewFocalPoint: productAsset ? productAsset.focalPoint || undefined : undefined,
            productVariantName: productTranslation.name,
            productVariantAssetId: undefined,
            productVariantPreview: '',
            productVariantPreviewFocalPoint: undefined,
            price: 0,
            priceWithTax: 0,
            currencyCode: ctx.currencyCode,
            description: productTranslation.description,
            facetIds: product.facetValues?.map(fv => fv.facet.id.toString()) ?? [],
            channelIds: [ctx.channelId],
            facetValueIds: product.facetValues?.map(fv => fv.id.toString()) ?? [],
            collectionIds: [],
            collectionSlugs: [],
            enabled: false,
            productEnabled: false,
            productPriceMin: 0,
            productPriceMax: 0,
            productPriceWithTaxMin: 0,
            productPriceWithTaxMax: 0,
            productFacetIds: product.facetValues?.map(fv => fv.facet.id.toString()) ?? [],
            productFacetValueIds: product.facetValues?.map(fv => fv.id.toString()) ?? [],
            productCollectionIds: [],
            productCollectionSlugs: [],
            productChannelIds: product.channels.map(c => c.id),
            inStock: false,
            productInStock: false,
        };
        const productCustomMappings = Object.entries(this.options.customProductMappings);
        for (const [name, def] of productCustomMappings) {
            item[`product-${name}`] = await def.valueFn(product, [], languageCode, this.injector, ctx);
        }
        return item;
    }

    private getTranslation<T extends Translatable>(
        translatable: T,
        languageCode: LanguageCode,
    ): Translation<T> {
        return (translatable.translations.find(t => t.languageCode === languageCode) ||
            translatable.translations.find(t => t.languageCode === this.configService.defaultLanguageCode) ||
            translatable.translations[0]) as unknown as Translation<T>;
    }

    private getFacetIds(variants: ProductVariant[]): string[] {
        const facetIds = (fv: FacetValue) => fv.facet.id.toString();
        const variantFacetIds = variants.reduce(
            (ids, v) => [...ids, ...v.facetValues.map(facetIds)],
            [] as string[],
        );
        const productFacetIds = variants[0].product.facetValues.map(facetIds);
        return unique([...variantFacetIds, ...productFacetIds]);
    }

    private getFacetValueIds(variants: ProductVariant[]): string[] {
        const facetValueIds = (fv: FacetValue) => fv.id.toString();
        const variantFacetValueIds = variants.reduce(
            (ids, v) => [...ids, ...v.facetValues.map(facetValueIds)],
            [] as string[],
        );
        const productFacetValueIds = variants[0].product.facetValues.map(facetValueIds);
        return unique([...variantFacetValueIds, ...productFacetValueIds]);
    }

    private getId(
        entityId: ID,
        channelId: ID,
        languageCode: LanguageCode,
        currencyCode: CurrencyCode,
    ): string {
        return buildVariantDocId(
            this.options.indexCurrencyCode,
            entityId,
            channelId,
            languageCode,
            currencyCode,
        );
    }

    private getChannelIndexCurrencies(channel: Channel): CurrencyCode[] {
        return resolveChannelIndexCurrencies(this.options.indexCurrencyCode, channel);
    }
}
