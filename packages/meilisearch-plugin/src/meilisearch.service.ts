import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { SearchResultAsset } from '@vendure/common/lib/generated-types';
import { LogicalOperator, SortOrder } from '@vendure/common/lib/generated-types';
import {
    Collection,
    CollectionService,
    ConfigService,
    DeepRequired,
    EventBus,
    FacetValue,
    FacetValueService,
    ID,
    InternalServerError,
    Job,
    Logger,
    RequestContext,
    SearchEvent,
    SearchService,
} from '@vendure/core';
import { UserInputError } from '@vendure/core';
import { MeiliSearch } from 'meilisearch';

import { MEILISEARCH_OPTIONS, loggerCtx, VARIANT_INDEX_NAME } from './constants';
import { getClient, getIndexUid, createIndex, configureIndex } from './indexing/indexing-utils';
import { MeilisearchIndexService } from './indexing/meilisearch-index.service';
import { MeilisearchRuntimeOptions } from './options';
import {
    CustomMapping,
    MeilisearchSearchInput,
    MeilisearchSearchResponse,
    MeilisearchSearchResult,
    ProductIndexItem,
    SearchPriceData,
    VariantIndexItem,
} from './types';

@Injectable()
export class MeilisearchService implements OnModuleInit {
    private client: MeiliSearch;

    constructor(
        @Inject(MEILISEARCH_OPTIONS) private options: MeilisearchRuntimeOptions,
        private searchService: SearchService,
        private meilisearchIndexService: MeilisearchIndexService,
        private configService: ConfigService,
        private facetValueService: FacetValueService,
        private collectionService: CollectionService,
        private eventBus: EventBus,
    ) {
        searchService.adopt(this);
    }

    onModuleInit(): any {
        this.client = getClient(this.options);
    }

    async checkConnection(): Promise<void> {
        const { connectionAttempts, connectionAttemptInterval } = this.options;
        let attempts = 0;
        Logger.verbose('Pinging Meilisearch...', loggerCtx);
        while (attempts < connectionAttempts) {
            attempts++;
            try {
                const health = await this.client.health();
                if (health.status === 'available') {
                    Logger.verbose('Ping to Meilisearch successful', loggerCtx);
                    return;
                }
            } catch (e: any) {
                Logger.verbose(
                    `Ping to Meilisearch failed with error "${e.message as string}"`,
                    loggerCtx,
                );
            }
            Logger.verbose(
                `Connection to Meilisearch could not be made, trying again after ${connectionAttemptInterval}ms (attempt ${attempts} of ${connectionAttempts})`,
                loggerCtx,
            );
            await new Promise(resolve1 => setTimeout(resolve1, connectionAttemptInterval));
        }
        throw new Error('Could not connect to Meilisearch. Aborting bootstrap.');
    }

    async createIndicesIfNotExists(): Promise<void> {
        const indexUid = getIndexUid(this.options.indexPrefix, VARIANT_INDEX_NAME);
        try {
            await this.client.getIndex(indexUid);
            Logger.verbose(`Index "${indexUid}" exists`, loggerCtx);
        } catch (e: any) {
            Logger.verbose(`Index "${indexUid}" does not exist. Creating...`, loggerCtx);
            await createIndex(this.client, indexUid, 'id');
            await configureIndex(this.client, indexUid, this.options);
        }
    }

    /**
     * Perform a fulltext search according to the provided input arguments.
     */
    async search(
        ctx: RequestContext,
        input: MeilisearchSearchInput,
        enabledOnly: boolean = false,
    ): Promise<Omit<MeilisearchSearchResponse, 'facetValues' | 'collections' | 'priceRange'>> {
        const { groupByProduct, groupBySKU } = input;
        const indexUid = getIndexUid(this.options.indexPrefix, VARIANT_INDEX_NAME);
        const index = this.client.index(indexUid);

        if (groupByProduct && groupBySKU) {
            throw new InternalServerError(
                'Cannot use both groupByProduct and groupBySKU simultaneously. Please set only one of these options to true.',
            );
        }

        const filter = this.buildFilter(ctx, input, enabledOnly);
        const sort = this.buildSort(input);
        const offset = input.skip || 0;
        const limit = input.take || 10;

        const searchParams: any = {
            filter,
            sort,
            offset,
            limit,
        };

        if (groupByProduct) {
            searchParams.distinct = 'productId';
        } else if (groupBySKU) {
            searchParams.distinct = 'sku';
        }

        // Apply query-time search config options from plugin configuration
        const sc = this.options.searchConfig;
        if (sc.matchingStrategy) {
            searchParams.matchingStrategy = sc.matchingStrategy;
        }
        if (sc.attributesToSearchOn) {
            searchParams.attributesToSearchOn = sc.attributesToSearchOn;
        }
        if (sc.attributesToRetrieve) {
            searchParams.attributesToRetrieve = sc.attributesToRetrieve;
        }
        if (sc.rankingScoreThreshold !== undefined) {
            searchParams.rankingScoreThreshold = sc.rankingScoreThreshold;
        }
        if (sc.attributesToHighlight) {
            searchParams.attributesToHighlight = sc.attributesToHighlight;
        }
        if (sc.highlightPreTag) {
            searchParams.highlightPreTag = sc.highlightPreTag;
        }
        if (sc.highlightPostTag) {
            searchParams.highlightPostTag = sc.highlightPostTag;
        }
        if (sc.attributesToCrop) {
            searchParams.attributesToCrop = sc.attributesToCrop;
        }
        if (sc.cropLength !== undefined) {
            searchParams.cropLength = sc.cropLength;
        }
        if (sc.cropMarker !== undefined) {
            searchParams.cropMarker = sc.cropMarker;
        }
        if (sc.showMatchesPosition) {
            searchParams.showMatchesPosition = sc.showMatchesPosition;
        }
        if (sc.showRankingScore) {
            searchParams.showRankingScore = sc.showRankingScore;
        }
        if (sc.showRankingScoreDetails) {
            searchParams.showRankingScoreDetails = sc.showRankingScoreDetails;
        }

        // Apply mapQuery if configured
        const finalParams = this.options.searchConfig.mapQuery
            ? this.options.searchConfig.mapQuery(
                  searchParams,
                  input,
                  this.options.searchConfig,
                  ctx.channelId,
                  enabledOnly,
                  ctx,
              )
            : searchParams;

        try {
            const result = await index.search(input.term || '', finalParams);
            await this.eventBus.publish(new SearchEvent(ctx, input));

            if (groupByProduct || groupBySKU) {
                const totalItems = await this.totalHits(ctx, input, enabledOnly);
                return {
                    items: result.hits.map((hit: any) =>
                        this.mapProductToSearchResult(hit, groupByProduct ?? false, groupBySKU ?? false),
                    ),
                    totalItems,
                };
            } else {
                return {
                    items: result.hits.map((hit: any) => this.mapVariantToSearchResult(hit)),
                    totalItems: (result as any).estimatedTotalHits || (result as any).totalHits || 0,
                };
            }
        } catch (e: any) {
            Logger.error(e.message, loggerCtx, e.stack);
            throw e;
        }
    }

    async totalHits(
        ctx: RequestContext,
        input: MeilisearchSearchInput,
        enabledOnly: boolean = false,
    ): Promise<number> {
        const indexUid = getIndexUid(this.options.indexPrefix, VARIANT_INDEX_NAME);
        const index = this.client.index(indexUid);
        const { groupByProduct, groupBySKU } = input;

        const filter = this.buildFilter(ctx, input, enabledOnly);

        if (groupByProduct || groupBySKU) {
            // To count distinct productIds or SKUs, we search with distinct and use facets
            const distinctField = groupBySKU ? 'sku' : 'productId';
            const searchParams: any = {
                filter,
                offset: 0,
                limit: 0,
                facets: [distinctField],
                distinct: distinctField,
            };
            try {
                const result = await index.search(input.term || '', searchParams);
                // Use facetDistribution to get the exact distinct count
                // because estimatedTotalHits is inaccurate with distinct + limit:0
                const facetDist = (result as any).facetDistribution?.[distinctField];
                if (facetDist) {
                    return Object.keys(facetDist).length;
                }
                return (result as any).estimatedTotalHits || (result as any).totalHits || 0;
            } catch (e: any) {
                Logger.error(e.message, loggerCtx, e.stack);
                return 0;
            }
        } else {
            const result = await index.search(input.term || '', {
                filter,
                offset: 0,
                limit: 0,
            });
            return (result as any).estimatedTotalHits || (result as any).totalHits || 0;
        }
    }

    /**
     * Return a list of all FacetValues which appear in the result set.
     */
    async facetValues(
        ctx: RequestContext,
        input: MeilisearchSearchInput,
        enabledOnly: boolean = false,
    ): Promise<Array<{ facetValue: FacetValue; count: number }>> {
        const indexUid = getIndexUid(this.options.indexPrefix, VARIANT_INDEX_NAME);
        const index = this.client.index(indexUid);
        const filter = this.buildFilter(ctx, input, enabledOnly);

        try {
            const { groupByProduct } = input;
            // When grouped by product, use productFacetValueIds to get per-product counts
            const facetField = groupByProduct ? 'productFacetValueIds' : 'facetValueIds';
            const searchParams: any = {
                filter,
                offset: 0,
                limit: 0,
                facets: [facetField],
            };
            if (groupByProduct) {
                searchParams.distinct = 'productId';
            }
            const result = await index.search(input.term || '', searchParams);

            const facetDistribution = result.facetDistribution?.[facetField] || {};
            const facetValueIds = Object.keys(facetDistribution).slice(
                0,
                this.options.searchConfig.facetValueMaxSize,
            );

            if (facetValueIds.length === 0) {
                return [];
            }

            const facetValues = await this.facetValueService.findByIds(ctx, facetValueIds);
            return facetValues.map(facetValue => {
                const count = facetDistribution[facetValue.id.toString()] || 0;
                return { facetValue, count };
            });
        } catch (e: any) {
            Logger.error(e.message, loggerCtx, e.stack);
            return [];
        }
    }

    /**
     * Return a list of all Collections which appear in the result set.
     */
    async collections(
        ctx: RequestContext,
        input: MeilisearchSearchInput,
        enabledOnly: boolean = false,
    ): Promise<Array<{ collection: Collection; count: number }>> {
        const indexUid = getIndexUid(this.options.indexPrefix, VARIANT_INDEX_NAME);
        const index = this.client.index(indexUid);
        const filter = this.buildFilter(ctx, input, enabledOnly);

        try {
            const { groupByProduct } = input;
            // When grouped by product, use productCollectionIds to get per-product counts
            const collectionField = groupByProduct ? 'productCollectionIds' : 'collectionIds';
            const searchParams: any = {
                filter,
                offset: 0,
                limit: 0,
                facets: [collectionField],
            };
            if (groupByProduct) {
                searchParams.distinct = 'productId';
            }
            const result = await index.search(input.term || '', searchParams);

            const collectionDistribution = result.facetDistribution?.[collectionField] || {};
            const collectionIds = Object.keys(collectionDistribution).slice(
                0,
                this.options.searchConfig.collectionMaxSize,
            );

            if (collectionIds.length === 0) {
                return [];
            }

            const collections = await this.collectionService.findByIds(ctx, collectionIds);
            return collections.map(collection => {
                const count = collectionDistribution[collection.id.toString()] || 0;
                return { collection, count };
            });
        } catch (e: any) {
            Logger.error(e.message, loggerCtx, e.stack);
            return [];
        }
    }

    async priceRange(ctx: RequestContext, input: MeilisearchSearchInput): Promise<SearchPriceData> {
        const indexUid = getIndexUid(this.options.indexPrefix, VARIANT_INDEX_NAME);
        const index = this.client.index(indexUid);
        const filter = this.buildFilter(ctx, input, true);

        try {
            const result = await index.search(input.term || '', {
                filter,
                offset: 0,
                limit: 0,
                facets: ['price', 'priceWithTax'],
            });

            const facetStats = result.facetStats || {};
            const priceStats = facetStats.price || { min: 0, max: 0 };
            const priceWithTaxStats = facetStats.priceWithTax || { min: 0, max: 0 };

            const bucketInterval = this.options.searchConfig.priceRangeBucketInterval;

            // Generate price buckets by searching with filter ranges
            const buckets = await this.generatePriceBuckets(
                index,
                input.term || '',
                filter,
                'price',
                priceStats.min,
                priceStats.max,
                bucketInterval,
            );

            const bucketsWithTax = await this.generatePriceBuckets(
                index,
                input.term || '',
                filter,
                'priceWithTax',
                priceWithTaxStats.min,
                priceWithTaxStats.max,
                bucketInterval,
            );

            return {
                range: {
                    min: Math.round(priceStats.min) || 0,
                    max: Math.round(priceStats.max) || 0,
                },
                rangeWithTax: {
                    min: Math.round(priceWithTaxStats.min) || 0,
                    max: Math.round(priceWithTaxStats.max) || 0,
                },
                buckets,
                bucketsWithTax,
            };
        } catch (e: any) {
            Logger.error(e.message, loggerCtx, e.stack);
            throw new InternalServerError(
                'An error occurred when querying Meilisearch for priceRange data',
            );
        }
    }

    /**
     * Rebuilds the full search index.
     */
    async reindex(ctx: RequestContext): Promise<Job> {
        const job = await this.meilisearchIndexService.reindex(ctx);
        return job;
    }

    private async generatePriceBuckets(
        index: any,
        term: string,
        baseFilter: string,
        field: string,
        min: number,
        max: number,
        interval: number,
    ): Promise<Array<{ to: number; count: number }>> {
        const buckets: Array<{ to: number; count: number }> = [];
        if (min === 0 && max === 0) {
            return buckets;
        }
        let bucketStart = Math.floor(min / interval) * interval;
        while (bucketStart <= max) {
            const bucketEnd = bucketStart + interval;
            const bucketFilter = baseFilter
                ? `${baseFilter} AND ${field} >= ${bucketStart} AND ${field} < ${bucketEnd}`
                : `${field} >= ${bucketStart} AND ${field} < ${bucketEnd}`;

            try {
                const result = await index.search(term, {
                    filter: bucketFilter,
                    offset: 0,
                    limit: 0,
                });
                const count = (result).estimatedTotalHits || (result).totalHits || 0;
                if (count > 0) {
                    buckets.push({ to: bucketEnd, count });
                }
            } catch {
                // Skip this bucket if search fails
            }
            bucketStart = bucketEnd;
        }
        return buckets;
    }

    private buildFilter(
        ctx: RequestContext,
        input: MeilisearchSearchInput,
        enabledOnly: boolean,
    ): string {
        const filterParts: string[] = [];

        filterParts.push(`channelId = "${ctx.channelId}"`);
        filterParts.push(`languageCode = "${ctx.languageCode}"`);

        if (enabledOnly) {
            filterParts.push('enabled = true');
        }

        const {
            facetValueIds,
            facetValueOperator,
            facetValueFilters,
            collectionId,
            collectionSlug,
            groupByProduct,
            priceRange,
            priceRangeWithTax,
            inStock,
        } = input;

        if (facetValueIds && facetValueIds.length) {
            if (facetValueOperator === LogicalOperator.AND) {
                for (const id of facetValueIds) {
                    filterParts.push(`facetValueIds = "${id}"`);
                }
            } else {
                const orParts = facetValueIds.map(id => `facetValueIds = "${id}"`);
                filterParts.push(`(${orParts.join(' OR ')})`);
            }
        }

        if (facetValueFilters && facetValueFilters.length) {
            for (const facetValueFilter of facetValueFilters) {
                if (facetValueFilter.and && facetValueFilter.or && facetValueFilter.or.length) {
                    throw new UserInputError('error.facetfilterinput-invalid-input');
                }
                if (facetValueFilter.and) {
                    filterParts.push(`facetValueIds = "${facetValueFilter.and}"`);
                }
                if (facetValueFilter.or && facetValueFilter.or.length) {
                    const orParts = facetValueFilter.or.map(id => `facetValueIds = "${id}"`);
                    filterParts.push(`(${orParts.join(' OR ')})`);
                }
            }
        }

        if (collectionId) {
            filterParts.push(`collectionIds = "${collectionId}"`);
        }
        const collectionIds = input.collectionIds as string[] | undefined;
        if (collectionIds && collectionIds.length) {
            const uniqueIds = Array.from(new Set(collectionIds));
            const orParts = uniqueIds.map(id => `collectionIds = "${id}"`);
            filterParts.push(`(${orParts.join(' OR ')})`);
        }
        if (collectionSlug) {
            filterParts.push(`collectionSlugs = "${collectionSlug}"`);
        }
        const collectionSlugs: string[] | undefined = input.collectionSlugs;
        if (collectionSlugs && collectionSlugs.length) {
            const uniqueSlugs = Array.from(new Set(collectionSlugs));
            const orParts = uniqueSlugs.map(slug => `collectionSlugs = "${slug}"`);
            filterParts.push(`(${orParts.join(' OR ')})`);
        }

        if (priceRange) {
            filterParts.push(`price >= ${priceRange.min}`);
            filterParts.push(`price <= ${priceRange.max}`);
        }
        if (priceRangeWithTax) {
            filterParts.push(`priceWithTax >= ${priceRangeWithTax.min}`);
            filterParts.push(`priceWithTax <= ${priceRangeWithTax.max}`);
        }

        if (inStock !== undefined) {
            if (groupByProduct) {
                filterParts.push(`productInStock = ${inStock}`);
            } else {
                filterParts.push(`inStock = ${inStock}`);
            }
        }

        return filterParts.join(' AND ');
    }

    private buildSort(input: MeilisearchSearchInput): string[] {
        const sortArray: string[] = [];
        if (input.sort) {
            if (input.sort.name) {
                sortArray.push(`productName:${input.sort.name === SortOrder.ASC ? 'asc' : 'desc'}`);
            }
            if (input.sort.price) {
                sortArray.push(`price:${input.sort.price === SortOrder.ASC ? 'asc' : 'desc'}`);
            }
        }
        return this.options.searchConfig.mapSort
            ? this.options.searchConfig.mapSort(sortArray, input)
            : sortArray;
    }

    private mapVariantToSearchResult(hit: any): MeilisearchSearchResult {
        const source: VariantIndexItem = hit;
        const { productAsset, productVariantAsset } = this.getSearchResultAssets(source);
        const result: any = {
            ...source,
            productAsset,
            productVariantAsset,
            price: {
                value: source.price,
            },
            priceWithTax: {
                value: source.priceWithTax,
            },
            score: (hit)._rankingScore || 0,
        };

        MeilisearchService.addCustomMappings(
            result,
            source,
            this.options.customProductMappings,
            this.options.customProductVariantMappings,
            false,
            false,
        );
        return result;
    }

    private mapProductToSearchResult(
        hit: any,
        groupByProduct: boolean = false,
        groupBySKU: boolean = false,
    ): MeilisearchSearchResult {
        const source: VariantIndexItem = hit;
        const { productAsset, productVariantAsset } = this.getSearchResultAssets(source);
        const result: any = {
            ...source,
            productAsset,
            productVariantAsset,
            enabled: source.productEnabled,
            productId: source.productId.toString(),
            productName: source.productName,
            productVariantId: source.productVariantId.toString(),
            productVariantName: source.productVariantName,
            facetIds: source.productFacetIds as string[],
            facetValueIds: source.productFacetValueIds as string[],
            collectionIds: source.productCollectionIds as string[],
            sku: source.sku,
            slug: source.slug,
            price: {
                min: source.productPriceMin,
                max: source.productPriceMax,
            },
            priceWithTax: {
                min: source.productPriceWithTaxMin,
                max: source.productPriceWithTaxMax,
            },
            channelIds: [],
            inStock: source.productInStock,
            score: (hit)._rankingScore || 0,
        };
        MeilisearchService.addCustomMappings(
            result,
            source,
            this.options.customProductMappings,
            this.options.customProductVariantMappings,
            groupByProduct,
            groupBySKU,
        );
        return result;
    }

    private getSearchResultAssets(source: ProductIndexItem | VariantIndexItem): {
        productAsset: SearchResultAsset | undefined;
        productVariantAsset: SearchResultAsset | undefined;
    } {
        const productAsset: SearchResultAsset | undefined = source.productAssetId
            ? {
                  id: source.productAssetId.toString(),
                  preview: source.productPreview,
                  focalPoint: source.productPreviewFocalPoint,
              }
            : undefined;
        const productVariantAsset: SearchResultAsset | undefined = source.productVariantAssetId
            ? {
                  id: source.productVariantAssetId.toString(),
                  preview: source.productVariantPreview,
                  focalPoint: source.productVariantPreviewFocalPoint,
              }
            : undefined;
        return { productAsset, productVariantAsset };
    }

    private static addCustomMappings(
        result: any,
        source: any,
        productMappings: { [fieldName: string]: CustomMapping<any> },
        variantMappings: { [fieldName: string]: CustomMapping<any> },
        groupByProduct: boolean,
        groupBySKU: boolean,
    ): any {
        const productCustomMappings = Object.keys(productMappings);
        if (productCustomMappings.length) {
            const customMappingsResult: any = {};
            for (const name of productCustomMappings) {
                customMappingsResult[name] = source[`product-${name}`];
            }
            result.customProductMappings = customMappingsResult;
            if (groupByProduct || groupBySKU) {
                result.customMappings = customMappingsResult;
            }
        }
        const variantCustomMappings = Object.keys(variantMappings);
        if (variantCustomMappings.length) {
            const customMappingsResult: any = {};
            for (const name of variantCustomMappings) {
                customMappingsResult[name] = source[`variant-${name}`];
            }
            result.customProductVariantMappings = customMappingsResult;
            if (!groupByProduct && !groupBySKU) {
                result.customMappings = customMappingsResult;
            }
        }
        return result;
    }
}
