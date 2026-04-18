import { Client } from '@opensearch-project/opensearch';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SearchResultAsset } from '@vendure/common/lib/generated-types';
import {
    Collection,
    CollectionService,
    ConfigService,
    DeepRequired,
    EventBus,
    FacetValue,
    FacetValueService,
    InternalServerError,
    Job,
    Logger,
    RequestContext,
    SearchEvent,
    SearchService,
} from '@vendure/core';
import equal from 'fast-deep-equal/es6';

import { buildSearchBody } from './build-search-body';
import { OPENSEARCH_OPTIONS, loggerCtx, VARIANT_INDEX_NAME } from './constants';
import { OpenSearchIndexService } from './indexing/opensearch-index.service';
import { createIndices, getClient } from './indexing/indexing-utils';
import { OpenSearchOptions } from './options';
import {
    CustomMapping,
    CustomScriptContext,
    CustomScriptMapping,
    OpenSearchInput,
    OpenSearchResponse,
    OpenSearchResult,
    ProductIndexItem,
    SearchHit,
    SearchPriceData,
    SearchResponseBody,
    VariantIndexItem,
} from './types';

@Injectable()
export class OpenSearchService implements OnModuleInit, OnModuleDestroy {
    private client: Client;

    constructor(
        @Inject(OPENSEARCH_OPTIONS) private options: DeepRequired<OpenSearchOptions>,
        private searchService: SearchService,
        private opensearchIndexService: OpenSearchIndexService,
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

    onModuleDestroy(): any {
        return this.client.close();
    }

    async checkConnection(): Promise<void> {
        // eslint-disable-next-line no-async-promise-executor
        await new Promise<void>(async (resolve, reject) => {
            const { connectionAttempts, connectionAttemptInterval } = this.options;
            let attempts = 0;
            Logger.verbose('Pinging OpenSearch...', loggerCtx);
            while (attempts < connectionAttempts) {
                attempts++;
                try {
                    const pingResult = await this.client.ping({}, { requestTimeout: 1000 });
                    if (pingResult.body) {
                        Logger.verbose('Ping to OpenSearch successful', loggerCtx);
                        return resolve();
                    }
                } catch (e: any) {
                    Logger.verbose(
                        `Ping to OpenSearch failed with error "${e.message as string}"`,
                        loggerCtx,
                    );
                }
                Logger.verbose(
                    `Connection to OpenSearch could not be made, trying again after ${connectionAttemptInterval}ms (attempt ${attempts} of ${connectionAttempts})`,
                    loggerCtx,
                );
                await new Promise(resolve1 => setTimeout(resolve1, connectionAttemptInterval));
            }
            reject('Could not connect to OpenSearch. Aborting bootstrap.');
        });
    }

    async createIndicesIfNotExists() {
        const { indexPrefix } = this.options;

        const createIndex = async (indexName: string) => {
            const index = indexPrefix + indexName;
            const result = await this.client.indices.exists({ index });

            if (!result.body) {
                Logger.verbose(`Index "${index}" does not exist. Creating...`, loggerCtx);
                await createIndices(
                    this.client,
                    indexPrefix,
                    this.options.indexSettings,
                    this.options.indexMappingProperties,
                );
            } else {
                Logger.verbose(`Index "${index}" exists`, loggerCtx);

                const existingIndexSettingsResult = await this.client.indices.getSettings({ index });
                let existingIndexSettings;

                if (existingIndexSettingsResult.body) {
                    existingIndexSettings = (existingIndexSettingsResult.body as Record<string, any>)[
                        Object.keys(existingIndexSettingsResult.body)[0]
                    ].settings.index;
                }

                const tempName = new Date().getTime();
                const nameSalt = Math.random().toString(36).substring(7);
                const tempPrefix = 'temp-' + `${tempName}-${nameSalt}-`;
                const tempIndex = tempPrefix + indexName;

                await createIndices(
                    this.client,
                    tempPrefix,
                    this.options.indexSettings,
                    this.options.indexMappingProperties,
                    false,
                );
                const tempIndexSettingsResult = await this.client.indices.getSettings({ index: tempIndex });
                const tempIndexSettings = tempIndexSettingsResult.body[tempIndex]?.settings?.index;

                const indexParamsToExclude = [
                    'routing',
                    'number_of_shards',
                    'provided_name',
                    'creation_date',
                    'number_of_replicas',
                    'uuid',
                    'version',
                ];
                for (const param of indexParamsToExclude) {
                    if (tempIndexSettings) {
                        delete tempIndexSettings[param];
                    }
                    if (existingIndexSettings) {
                        delete existingIndexSettings[param];
                    }
                }
                if (
                    tempIndexSettings &&
                    existingIndexSettings &&
                    !equal(tempIndexSettings, existingIndexSettings)
                )
                    Logger.warn(
                        `Index "${index}" settings differs from index setting in vendure config! Consider re-indexing the data.`,
                        loggerCtx,
                    );
                else {
                    const existingIndexMappingsResult = await this.client.indices.getMapping({ index });
                    const existingIndexMappings =
                        existingIndexMappingsResult.body[Object.keys(existingIndexMappingsResult.body)[0]]
                            .mappings;

                    const tempIndexMappingsResult = await this.client.indices.getMapping({
                        index: tempIndex,
                    });
                    const tempIndexMappings = tempIndexMappingsResult.body[tempIndex].mappings;
                    if (!equal(tempIndexMappings, existingIndexMappings))

                        Logger.warn(
                            `Index "${index}" mapping differs from index mapping in vendure config! Consider re-indexing the data.`,
                            loggerCtx,
                        );
                }

                await this.client.indices.delete({
                    index: [tempPrefix + 'variants'],
                });
            }
        };

        await createIndex(VARIANT_INDEX_NAME);
    }

    /**
     * Perform a fulltext search according to the provided input arguments.
     */
    async search(
        ctx: RequestContext,
        input: OpenSearchInput,
        enabledOnly: boolean = false,
    ): Promise<Omit<OpenSearchResponse, 'facetValues' | 'collections' | 'priceRange'>> {
        const { indexPrefix } = this.options;
        const { groupByProduct, groupBySKU } = input;
        const opensearchBody = buildSearchBody(
            input,
            this.options.searchConfig,
            ctx.channelId,
            ctx.languageCode,
            enabledOnly,
            ctx,
        );

        if (groupByProduct && groupBySKU) {
            throw new InternalServerError(
                'Cannot use both groupByProduct and groupBySKU simultaneously. Please set only one of these options to true.',
            );
        }

        if (groupByProduct || groupBySKU) {
            try {
                const { body } = await this.client.search({
                    index: indexPrefix + VARIANT_INDEX_NAME,
                    body: opensearchBody,
                });

                const totalItems = await this.totalHits(ctx, input, enabledOnly);

                await this.eventBus.publish(new SearchEvent(ctx, input));
                return {
                    items: body.hits.hits.map((hit: any) =>
                        this.mapProductToSearchResult(
                            hit as SearchHit<VariantIndexItem>,
                            groupByProduct,
                            groupBySKU,
                        ),
                    ),
                    totalItems,
                };
            } catch (e: any) {
                if (e.meta?.body?.error?.type && e.meta.body.error.type === 'search_phase_execution_exception') {
                    // Log runtime error of the script exception instead of stacktrace
                    Logger.error(
                        e.message,
                        loggerCtx,
                        JSON.stringify(e.meta.body.error.root_cause || [], null, 2),
                    );
                    Logger.verbose(JSON.stringify(e.meta.body.error.failed_shards || [], null, 2), loggerCtx);
                } else {
                    Logger.error(e.message, loggerCtx, e.stack);
                }
                throw e;
            }
        } else {
            try {
                const { body } = await this.client.search({
                    index: indexPrefix + VARIANT_INDEX_NAME,
                    body: opensearchBody,
                });
                await this.eventBus.publish(new SearchEvent(ctx, input));
                return {
                    items: body.hits.hits.map((hit: any) =>
                        this.mapVariantToSearchResult(hit as SearchHit<VariantIndexItem>),
                    ),
                    totalItems: Number(
                        body.hits.total && typeof body.hits.total === 'object' ? body.hits.total.value : 0,
                    ),
                };
            } catch (e: any) {
                if (e.meta?.body?.error?.type && e.meta.body.error.type === 'search_phase_execution_exception') {
                    // Log runtime error of the script exception instead of stacktrace
                    Logger.error(
                        e.message,
                        loggerCtx,
                        JSON.stringify(e.meta.body.error.root_cause || [], null, 2),
                    );
                    Logger.verbose(JSON.stringify(e.meta.body.error.failed_shards || [], null, 2), loggerCtx);
                } else {
                    Logger.error(e.message, loggerCtx, e.stack);
                }
                throw e;
            }
        }
    }

    async totalHits(
        ctx: RequestContext,
        input: OpenSearchInput,
        enabledOnly: boolean = false,
    ): Promise<number> {
        const { indexPrefix, searchConfig } = this.options;
        const { groupBySKU } = input;
        const opensearchBody = buildSearchBody(
            input,
            searchConfig,
            ctx.channelId,
            ctx.languageCode,
            enabledOnly,
            ctx,
        );
        opensearchBody.from = 0;
        opensearchBody.size = 0;
        opensearchBody.aggs = {
            total: {
                cardinality: {
                    field: groupBySKU ? 'sku.keyword' : 'productId',
                },
            },
        };
        const response = await this.client.search({
            index: indexPrefix + VARIANT_INDEX_NAME,
            body: opensearchBody,
        });

        const { aggregations } = response.body;
        if (!aggregations) {
            throw new InternalServerError(
                'An error occurred when querying OpenSearch for priceRange aggregations',
            );
        }
        return aggregations.total && (aggregations.total as any).value != null
            ? Number((aggregations.total as any).value)
            : 0;
    }

    /**
     * Return a list of all FacetValues which appear in the result set.
     */
    async facetValues(
        ctx: RequestContext,
        input: OpenSearchInput,
        enabledOnly: boolean = false,
    ): Promise<Array<{ facetValue: FacetValue; count: number }>> {
        const { groupByProduct, groupBySKU } = input;
        const buckets = await this.getDistinctBucketsOfField(
            ctx,
            input,
            enabledOnly,
            'facetValueIds',
            this.options.searchConfig.facetValueMaxSize,
        );

        const facetValues = await this.facetValueService.findByIds(
            ctx,
            buckets.map(b => b.key),
        );
        return facetValues.map(facetValue => {
            const bucket = buckets.find(b => b.key.toString() === facetValue.id.toString());
            let count;
            if (groupByProduct || groupBySKU) {
                count = bucket ? bucket.total.value : 0;
            } else {
                count = bucket ? bucket.doc_count : 0;
            }
            return {
                facetValue,
                count,
            };
        });
    }

    /**
     * Return a list of all Collections which appear in the result set.
     */
    async collections(
        ctx: RequestContext,
        input: OpenSearchInput,
        enabledOnly: boolean = false,
    ): Promise<Array<{ collection: Collection; count: number }>> {
        const { groupByProduct, groupBySKU } = input;
        const buckets = await this.getDistinctBucketsOfField(
            ctx,
            input,
            enabledOnly,
            'collectionIds',
            this.options.searchConfig.collectionMaxSize,
        );

        const collections = await this.collectionService.findByIds(
            ctx,
            buckets.map(b => b.key),
        );
        return collections.map(collection => {
            const bucket = buckets.find(b => b.key.toString() === collection.id.toString());
            let count;
            if (groupByProduct || groupBySKU) {
                count = bucket ? bucket.total.value : 0;
            } else {
                count = bucket ? bucket.doc_count : 0;
            }
            return {
                collection,
                count,
            };
        });
    }

    async getDistinctBucketsOfField(
        ctx: RequestContext,
        input: OpenSearchInput,
        enabledOnly: boolean = false,
        field: string,
        aggregation_max_size: number,
    ): Promise<Array<{ key: string; doc_count: number; total: { value: number } }>> {
        const { indexPrefix } = this.options;
        const { groupByProduct, groupBySKU } = input;
        const opensearchBody = buildSearchBody(
            input,
            this.options.searchConfig,
            ctx.channelId,
            ctx.languageCode,
            enabledOnly,
            ctx,
        );
        opensearchBody.from = 0;
        opensearchBody.size = 0;
        opensearchBody.aggs = {
            aggregation_field: {
                terms: {
                    field,
                    size: aggregation_max_size,
                },
            },
        };

        if (groupByProduct) {
            opensearchBody.aggs.aggregation_field.aggs = {
                total: {
                    cardinality: {
                        field: 'productId',
                    },
                },
            };
        }

        if (groupBySKU) {
            opensearchBody.aggs.aggregation_field.aggs = {
                total: {
                    cardinality: {
                        field: 'sku.keyword',
                    },
                },
            };
        }

        let body;
        try {
            const result = await this.client.search<SearchResponseBody<VariantIndexItem>>({
                index: indexPrefix + VARIANT_INDEX_NAME,
                body: opensearchBody,
            });
            body = result.body;
        } catch (e: any) {
            Logger.error(e.message, loggerCtx, e.stack);
            throw e;
        }

        return body.aggregations ? (body.aggregations.aggregation_field as any).buckets : [];
    }

    async priceRange(ctx: RequestContext, input: OpenSearchInput): Promise<SearchPriceData> {
        const { indexPrefix, searchConfig } = this.options;
        const opensearchBody = buildSearchBody(
            input,
            searchConfig,
            ctx.channelId,
            ctx.languageCode,
            true,
            ctx,
        );
        opensearchBody.from = 0;
        opensearchBody.size = 0;
        opensearchBody.aggs = {
            minPrice: {
                min: {
                    field: 'price',
                },
            },
            minPriceWithTax: {
                min: {
                    field: 'priceWithTax',
                },
            },
            maxPrice: {
                max: {
                    field: 'price',
                },
            },
            maxPriceWithTax: {
                max: {
                    field: 'priceWithTax',
                },
            },
            prices: {
                histogram: {
                    field: 'price',
                    interval: searchConfig.priceRangeBucketInterval,
                },
            },
            pricesWithTax: {
                histogram: {
                    field: 'priceWithTax',
                    interval: searchConfig.priceRangeBucketInterval,
                },
            },
        };
        const result = await this.client.search({
            index: indexPrefix + VARIANT_INDEX_NAME,
            body: opensearchBody,
        });

        const { aggregations } = result.body;
        if (!aggregations) {
            throw new InternalServerError(
                'An error occurred when querying OpenSearch for priceRange aggregations',
            );
        }
        const mapPriceBuckets = (b: { key: string; doc_count: number }) => ({
            to: Number.parseInt(b.key, 10) + searchConfig.priceRangeBucketInterval,
            count: b.doc_count,
        });

        return {
            range: {
                min: (aggregations.minPrice as any).value || 0,
                max: (aggregations.maxPrice as any).value || 0,
            },
            rangeWithTax: {
                min: (aggregations.minPriceWithTax as any).value || 0,
                max: (aggregations.maxPriceWithTax as any).value || 0,
            },
            buckets: (aggregations.prices as any).buckets
                .map(mapPriceBuckets)
                .filter((x: { count: number }) => 0 < x.count),
            bucketsWithTax: (aggregations.pricesWithTax as any).buckets
                .map(mapPriceBuckets)
                .filter((x: { count: number }) => 0 < x.count),
        };
    }

    /**
     * Rebuilds the full search index.
     */
    async reindex(ctx: RequestContext): Promise<Job> {
        const job = await this.opensearchIndexService.reindex(ctx);

        return job;
    }

    private mapVariantToSearchResult(hit: SearchHit<VariantIndexItem>): OpenSearchResult {
        const source = hit._source;
        const fields = hit.fields;
        const { productAsset, productVariantAsset } = this.getSearchResultAssets(source);
        const result = {
            ...source,
            productAsset,
            productVariantAsset,
            price: {
                value: source.price,
            },
            priceWithTax: {
                value: source.priceWithTax,
            },
            score: hit._score || 0,
        };

        OpenSearchService.addCustomMappings(
            result,
            source,
            this.options.customProductMappings,
            this.options.customProductVariantMappings,
            false,
            false,
        );
        OpenSearchService.addScriptMappings(
            result,
            fields,
            this.options.searchConfig?.scriptFields,
            'variant',
        );
        return result;
    }

    private mapProductToSearchResult(
        hit: SearchHit<VariantIndexItem>,
        groupByProduct: boolean = false,
        groupBySKU: boolean = false,
    ): OpenSearchResult {
        const source = hit._source;
        const fields = hit.fields;
        const { productAsset, productVariantAsset } = this.getSearchResultAssets(source);
        const result = {
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
            score: hit._score || 0,
        };
        OpenSearchService.addCustomMappings(
            result,
            source,
            this.options.customProductMappings,
            this.options.customProductVariantMappings,
            groupByProduct,
            groupBySKU,
        );
        OpenSearchService.addScriptMappings(
            result,
            fields,
            this.options.searchConfig?.scriptFields,
            'product',
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

    private static addScriptMappings(
        result: any,
        fields: any,
        mappings: { [fieldName: string]: CustomScriptMapping<any> },
        environment: CustomScriptContext,
    ): any {
        const customMappings = Object.keys(mappings || {});
        if (customMappings.length) {
            const customScriptFieldsResult: any = {};
            for (const name of customMappings) {
                const env = mappings[name].context;
                if (env === environment || env === 'both') {
                    const fieldVal = fields[name] || undefined;
                    if (Array.isArray(fieldVal)) {
                        if (fieldVal.length === 1) {
                            customScriptFieldsResult[name] = fieldVal[0];
                        }
                        if (fieldVal.length > 1) {
                            customScriptFieldsResult[name] = JSON.stringify(fieldVal);
                        }
                    } else {
                        customScriptFieldsResult[name] = fieldVal;
                    }
                }
            }
            result.customScriptFields = customScriptFieldsResult;
        }
        return result;
    }
}
