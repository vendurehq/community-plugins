import { NodeOptions } from '@opensearch-project/opensearch';
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
    AdminOpenSearchResolver,
    EntityOpenSearchResolver,
    ShopOpenSearchResolver,
} from './api/opensearch-resolver';
import { OPENSEARCH_OPTIONS, loggerCtx } from './constants';
import { OpenSearchHealthIndicator } from './opensearch.health';
import { OpenSearchService } from './opensearch.service';
import { OpenSearchIndexService } from './indexing/opensearch-index.service';
import { OpenSearchIndexerController } from './indexing/indexer.controller';
import { OpenSearchOptions, OpenSearchRuntimeOptions, mergeWithDefaults } from './options';

function getCustomResolvers(options: OpenSearchRuntimeOptions) {
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
 * This plugin allows your product search to be powered by [OpenSearch](https://opensearch.org/) — the
 * Apache 2.0 community fork of Elasticsearch maintained by the OpenSearch Project. This is a drop-in
 * replacement for the DefaultSearchPlugin which exposes many powerful configuration options enabling
 * your storefront to support a wide range of use-cases such as indexing of custom properties, fine
 * control over search index configuration, and to leverage advanced OpenSearch features like
 * cross-cluster replication and spatial search.
 *
 * @docsCategory OpenSearchPlugin
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [
        OpenSearchIndexService,
        OpenSearchService,
        OpenSearchHealthIndicator,
        OpenSearchIndexerController,
        SearchJobBufferService,
        { provide: OPENSEARCH_OPTIONS, useFactory: () => OpenSearchPlugin.options },
        {
            provide: BUFFER_SEARCH_INDEX_UPDATES,
            useFactory: () => OpenSearchPlugin.options.bufferUpdates === true,
        },
    ],
    adminApiExtensions: {
        resolvers: () => [
            AdminOpenSearchResolver,
            EntityOpenSearchResolver,
            ...getCustomResolvers(OpenSearchPlugin.options),
        ],
        schema: () => generateSchemaExtensions(OpenSearchPlugin.options as any),
    },
    shopApiExtensions: {
        resolvers: () => [
            ShopOpenSearchResolver,
            EntityOpenSearchResolver,
            ...getCustomResolvers(OpenSearchPlugin.options),
        ],
        // `any` cast is there due to a strange error "Property '[Symbol.iterator]' is missing in type... URLSearchParams"
        // which looks like possibly a TS/definitions bug.
        schema: () => generateSchemaExtensions(OpenSearchPlugin.options as any),
    },
    compatibility: '^3.0.0',
})
export class OpenSearchPlugin implements OnApplicationBootstrap {
    private static options: OpenSearchRuntimeOptions;

    /** @internal */
    constructor(
        private eventBus: EventBus,
        private opensearchService: OpenSearchService,
        private opensearchIndexService: OpenSearchIndexService,
        private opensearchHealthIndicator: OpenSearchHealthIndicator,
        private healthCheckRegistryService: HealthCheckRegistryService,
    ) {}

    /**
     * Set the plugin options.
     */
    static init(options: OpenSearchOptions): Type<OpenSearchPlugin> {
        this.options = mergeWithDefaults(options);
        return OpenSearchPlugin;
    }

    /** @internal */
    async onApplicationBootstrap(): Promise<void> {
        const nodeName = this.nodeName();
        try {
            await this.opensearchService.checkConnection();
        } catch (e: any) {
            Logger.error(`Could not connect to OpenSearch instance at "${nodeName}"`, loggerCtx);
            Logger.error(JSON.stringify(e), loggerCtx);
            return;
        }
        Logger.info(`Successfully connected to OpenSearch instance at "${nodeName}"`, loggerCtx);

        await this.opensearchService.createIndicesIfNotExists();
        this.eventBus.ofType(ProductEvent).subscribe(event => {
            if (event.type === 'deleted') {
                return this.opensearchIndexService.deleteProduct(event.ctx, event.product);
            } else {
                return this.opensearchIndexService.updateProduct(event.ctx, event.product);
            }
        });
        this.eventBus.ofType(ProductVariantEvent).subscribe(event => {
            if (event.type === 'deleted') {
                return this.opensearchIndexService.deleteVariant(event.ctx, event.variants);
            } else {
                return this.opensearchIndexService.updateVariants(event.ctx, event.variants);
            }
        });
        this.eventBus.ofType(AssetEvent).subscribe(event => {
            if (event.type === 'updated') {
                return this.opensearchIndexService.updateAsset(event.ctx, event.asset);
            }
            if (event.type === 'deleted') {
                return this.opensearchIndexService.deleteAsset(event.ctx, event.asset);
            }
        });

        this.eventBus.ofType(ProductChannelEvent).subscribe(event => {
            if (event.type === 'assigned') {
                return this.opensearchIndexService.assignProductToChannel(
                    event.ctx,
                    event.product,
                    event.channelId,
                );
            } else {
                return this.opensearchIndexService.removeProductFromChannel(
                    event.ctx,
                    event.product,
                    event.channelId,
                );
            }
        });

        this.eventBus.ofType(ProductVariantChannelEvent).subscribe(event => {
            if (event.type === 'assigned') {
                return this.opensearchIndexService.assignVariantToChannel(
                    event.ctx,
                    event.productVariant.id,
                    event.channelId,
                );
            } else {
                return this.opensearchIndexService.removeVariantFromChannel(
                    event.ctx,
                    event.productVariant.id,
                    event.channelId,
                );
            }
        });

        this.eventBus.ofType(StockMovementEvent).subscribe(event => {
            return this.opensearchIndexService.updateVariants(
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
                return this.opensearchIndexService.updateVariantsById(events.ctx, events.ids);
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
                    return this.opensearchService.reindex(event.ctx);
                }
            });
    }

    /**
     * Returns a string representation of the target node(s) that the OpenSearch
     * client is configured to connect to.
     */
    private nodeName(): string {
        const { host, port, clientOptions } = OpenSearchPlugin.options;
        const node = clientOptions?.node;
        const nodes = clientOptions?.nodes;
        if (nodes) {
            return [...(Array.isArray(nodes) ? nodes : [nodes])].join(', ');
        }
        if (node) {
            if (Array.isArray(node)) {
                return (node as any[])
                    .map((n: string | NodeOptions) => {
                        return typeof n === 'string' ? n : n.url.toString();
                    })
                    .join(', ');
            } else {
                return typeof node === 'string' ? node : node.url.toString();
            }
        }
        return `${host}:${port}`;
    }
}
