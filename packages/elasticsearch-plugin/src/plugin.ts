import { OnApplicationBootstrap } from '@nestjs/common';
import {
    AssetEvent,
    BUFFER_SEARCH_INDEX_UPDATES,
    CollectionModificationEvent,
    EventBus,
    HealthCheckRegistryService,
    ID,
    idsAreEqual,
    Logger,
    PluginCommonModule,
    ProductChannelEvent,
    ProductEvent,
    ProductVariantChannelEvent,
    ProductVariantEvent,
    SearchJobBufferService,
    StockMovementEvent,
    TaxRateModificationEvent,
    Type,
    VendurePlugin,
} from '@vendure/core';
import { buffer, debounceTime, delay, filter, map } from 'rxjs/operators';

import { generateSchemaExtensions } from './api/api-extensions';
import { CustomMappingsResolver } from './api/custom-mappings.resolver';
import { CustomScriptFieldsResolver } from './api/custom-script-fields.resolver';
import {
    AdminElasticSearchResolver,
    EntityElasticSearchResolver,
    ShopElasticSearchResolver,
} from './api/elasticsearch-resolver';
import { ELASTIC_SEARCH_OPTIONS, loggerCtx } from './constants';
import { ElasticsearchHealthIndicator } from './elasticsearch.health';
import { ElasticsearchService } from './elasticsearch.service';
import { ElasticsearchIndexService } from './indexing/elasticsearch-index.service';
import { ElasticsearchIndexerController } from './indexing/indexer.controller';
import { ElasticsearchOptions, ElasticsearchRuntimeOptions, mergeWithDefaults } from './options';

function getCustomResolvers(options: ElasticsearchRuntimeOptions) {
    const requiresUnionResolver =
        0 < Object.keys(options.customProductMappings || {}).length &&
        0 < Object.keys(options.customProductVariantMappings || {}).length;
    const requiresUnionScriptResolver =
        0 <
            Object.values(options.searchConfig.scriptFields || {}).filter(
                field => field.context !== 'product',
            ).length &&
        0 <
            Object.values(options.searchConfig.scriptFields || {}).filter(
                field => field.context !== 'variant',
            ).length;
    return [
        ...(requiresUnionResolver ? [CustomMappingsResolver] : []),
        ...(requiresUnionScriptResolver ? [CustomScriptFieldsResolver] : []),
    ];
}

/**
 * @description
 * This plugin powers your product search via a pluggable search backend. It
 * ships with ready-made adapters for
 * [Elasticsearch](https://github.com/elastic/elasticsearch) and
 * [OpenSearch](https://github.com/opensearch-project/OpenSearch), and lets
 * you provide your own adapter by implementing
 * {@link SearchClientAdapter}. This is a drop-in replacement for the
 * DefaultSearchPlugin which exposes many powerful configuration options
 * enabling your storefront to support a wide range of use-cases such as
 * indexing of custom properties, fine control over search index
 * configuration, and advanced features like spatial search.
 *
 * @docsCategory ElasticsearchPlugin
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [
        ElasticsearchIndexService,
        ElasticsearchService,
        ElasticsearchHealthIndicator,
        ElasticsearchIndexerController,
        SearchJobBufferService,
        { provide: ELASTIC_SEARCH_OPTIONS, useFactory: () => ElasticsearchPlugin.options },
        {
            provide: BUFFER_SEARCH_INDEX_UPDATES,
            useFactory: () => ElasticsearchPlugin.options.bufferUpdates === true,
        },
    ],
    adminApiExtensions: {
        resolvers: () => [
            AdminElasticSearchResolver,
            EntityElasticSearchResolver,
            ...getCustomResolvers(ElasticsearchPlugin.options),
        ],
        schema: () => generateSchemaExtensions(ElasticsearchPlugin.options),
    },
    shopApiExtensions: {
        resolvers: () => [
            ShopElasticSearchResolver,
            EntityElasticSearchResolver,
            ...getCustomResolvers(ElasticsearchPlugin.options),
        ],
        // `any` cast is there due to a strange error "Property '[Symbol.iterator]' is missing in type... URLSearchParams"
        // which looks like possibly a TS/definitions bug.
        schema: () => generateSchemaExtensions(ElasticsearchPlugin.options),
    },
    compatibility: '^3.0.0',
})
export class ElasticsearchPlugin implements OnApplicationBootstrap {
    private static options: ElasticsearchRuntimeOptions;

    /** @internal */
    constructor(
        private eventBus: EventBus,
        private elasticsearchService: ElasticsearchService,
        private elasticsearchIndexService: ElasticsearchIndexService,
        private elasticsearchHealthIndicator: ElasticsearchHealthIndicator,
        private healthCheckRegistryService: HealthCheckRegistryService,
    ) {}

    /**
     * Set the plugin options.
     */
    static init(options: ElasticsearchOptions): Type<ElasticsearchPlugin> {
        this.options = mergeWithDefaults(options);
        return ElasticsearchPlugin;
    }

    /** @internal */
    async onApplicationBootstrap(): Promise<void> {
        const backendLabel = this.backendLabel();
        try {
            await this.elasticsearchService.checkConnection();
        } catch (e: any) {
            Logger.error(`Could not connect to search backend (${backendLabel})`, loggerCtx);
            Logger.error(JSON.stringify(e), loggerCtx);
            return;
        }
        Logger.info(`Successfully connected to search backend (${backendLabel})`, loggerCtx);

        await this.elasticsearchService.createIndicesIfNotExists();
        this.eventBus.ofType(ProductEvent).subscribe(event => {
            if (event.type === 'deleted') {
                return this.elasticsearchIndexService.deleteProduct(event.ctx, event.product);
            } else {
                return this.elasticsearchIndexService.updateProduct(event.ctx, event.product);
            }
        });
        this.eventBus.ofType(ProductVariantEvent).subscribe(event => {
            if (event.type === 'deleted') {
                return this.elasticsearchIndexService.deleteVariant(event.ctx, event.variants);
            } else {
                return this.elasticsearchIndexService.updateVariants(event.ctx, event.variants);
            }
        });
        this.eventBus.ofType(AssetEvent).subscribe(event => {
            if (event.type === 'updated') {
                return this.elasticsearchIndexService.updateAsset(event.ctx, event.asset);
            }
            if (event.type === 'deleted') {
                return this.elasticsearchIndexService.deleteAsset(event.ctx, event.asset);
            }
        });

        this.eventBus.ofType(ProductChannelEvent).subscribe(event => {
            if (event.type === 'assigned') {
                return this.elasticsearchIndexService.assignProductToChannel(
                    event.ctx,
                    event.product,
                    event.channelId,
                );
            } else {
                return this.elasticsearchIndexService.removeProductFromChannel(
                    event.ctx,
                    event.product,
                    event.channelId,
                );
            }
        });

        this.eventBus.ofType(ProductVariantChannelEvent).subscribe(event => {
            if (event.type === 'assigned') {
                return this.elasticsearchIndexService.assignVariantToChannel(
                    event.ctx,
                    event.productVariant.id,
                    event.channelId,
                );
            } else {
                return this.elasticsearchIndexService.removeVariantFromChannel(
                    event.ctx,
                    event.productVariant.id,
                    event.channelId,
                );
            }
        });

        this.eventBus.ofType(StockMovementEvent).subscribe(event => {
            return this.elasticsearchIndexService.updateVariants(
                event.ctx,
                event.stockMovements.map(m => m.productVariant),
            );
        });

        // TODO: Remove this buffering logic because because we have dedicated buffering based on #1137
        const collectionModification$ = this.eventBus.ofType(CollectionModificationEvent);
        const closingNotifier$ = collectionModification$.pipe(debounceTime(50));
        collectionModification$
            .pipe(
                buffer(closingNotifier$),
                filter(events => 0 < events.length),
                map(events => ({
                    ctx: events[0].ctx,
                    ids: events.reduce((ids, e) => [...ids, ...e.productVariantIds], [] as ID[]),
                })),
                filter(e => 0 < e.ids.length),
            )
            .subscribe(events => {
                return this.elasticsearchIndexService.updateVariantsById(events.ctx, events.ids);
            });

        this.eventBus
            .ofType(TaxRateModificationEvent)
            // The delay prevents a "TransactionNotStartedError" (in SQLite/sqljs) by allowing any existing
            // transactions to complete before a new job is added to the queue (assuming the SQL-based
            // JobQueueStrategy).
            // TODO: should be able to remove owing to f0fd6625
            .pipe(delay(1))
            .subscribe(event => {
                const defaultTaxZone = event.ctx.channel.defaultTaxZone;
                if (defaultTaxZone && idsAreEqual(defaultTaxZone.id, event.taxRate.zone.id)) {
                    return this.elasticsearchService.reindex(event.ctx);
                }
            });
    }

    /**
     * Returns a human-readable label identifying the configured search
     * backend, purely for logging. Delegated to the service because the
     * plugin options now hold an adapter **factory** rather than an
     * instance, and inspecting the factory 's `.name` only gives us the
     * wrapping arrow — whereas the service has already called the factory
     * and can report the concrete adapter class name.
     */
    private backendLabel(): string {
        return this.elasticsearchService.getBackendLabel();
    }
}
