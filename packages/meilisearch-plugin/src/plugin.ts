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
import {
    AdminMeilisearchResolver,
    EntityMeilisearchResolver,
    ShopMeilisearchResolver,
} from './api/meilisearch-resolver';
import { MEILISEARCH_OPTIONS, loggerCtx } from './constants';
import { MeilisearchIndexerController } from './indexing/indexer.controller';
import { MeilisearchIndexService } from './indexing/meilisearch-index.service';
import { MeilisearchHealthIndicator } from './meilisearch.health';
import { MeilisearchService } from './meilisearch.service';
import { MeilisearchOptions, MeilisearchRuntimeOptions, mergeWithDefaults } from './options';

function getCustomResolvers(options: MeilisearchRuntimeOptions) {
    const requiresUnionResolver =
        0 < Object.keys(options.customProductMappings || {}).length &&
        0 < Object.keys(options.customProductVariantMappings || {}).length;
    return [
        ...(requiresUnionResolver ? [CustomMappingsResolver] : []),
    ];
}

/**
 * @description
 * This plugin allows your product search to be powered by
 * [Meilisearch](https://www.meilisearch.com/) - a powerful, fast, open-source search engine.
 * This is a drop-in replacement for the DefaultSearchPlugin which exposes configuration options
 * enabling your storefront to support a wide range of use-cases such as indexing of custom
 * properties, facet filtering, and price range searches.
 *
 * ## Installation
 *
 * `yarn add meilisearch`
 *
 * or
 *
 * `npm install meilisearch`
 *
 * Make sure to remove the `DefaultSearchPlugin` if it is still in the VendureConfig plugins array.
 *
 * Then add the `MeilisearchPlugin`, calling the `.init()` method with {@link MeilisearchOptions}:
 *
 * @example
 * ```ts
 * import { MeilisearchPlugin } from './plugins/meilisearch/src/plugin';
 *
 * const config: VendureConfig = {
 *   plugins: [
 *     MeilisearchPlugin.init({
 *       host: 'http://localhost:7700',
 *       apiKey: 'your-master-key',
 *       synonyms: {
 *         phone: ['mobile', 'smartphone'],
 *         laptop: ['notebook'],
 *       },
 *       stopWords: ['the', 'a', 'an'],
 *     }),
 *   ],
 * };
 * ```
 *
 * @docsCategory MeilisearchPlugin
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [
        MeilisearchIndexService,
        MeilisearchService,
        MeilisearchHealthIndicator,
        MeilisearchIndexerController,
        SearchJobBufferService,
        { provide: MEILISEARCH_OPTIONS, useFactory: () => MeilisearchPlugin.options },
        {
            provide: BUFFER_SEARCH_INDEX_UPDATES,
            useFactory: () => MeilisearchPlugin.options.bufferUpdates === true,
        },
    ],
    adminApiExtensions: {
        resolvers: () => [
            AdminMeilisearchResolver,
            EntityMeilisearchResolver,
            ...getCustomResolvers(MeilisearchPlugin.options),
        ],
        schema: () => generateSchemaExtensions(MeilisearchPlugin.options as any),
    },
    shopApiExtensions: {
        resolvers: () => [
            ShopMeilisearchResolver,
            EntityMeilisearchResolver,
            ...getCustomResolvers(MeilisearchPlugin.options),
        ],
        schema: () => generateSchemaExtensions(MeilisearchPlugin.options as any),
    },
    compatibility: '^3.0.0',
})
export class MeilisearchPlugin implements OnApplicationBootstrap {
    private static options: MeilisearchRuntimeOptions;

    /** @internal */
    constructor(
        private eventBus: EventBus,
        private meilisearchService: MeilisearchService,
        private meilisearchIndexService: MeilisearchIndexService,
        private meilisearchHealthIndicator: MeilisearchHealthIndicator,
        private healthCheckRegistryService: HealthCheckRegistryService,
    ) {}

    /**
     * Set the plugin options.
     */
    static init(options: MeilisearchOptions): Type<MeilisearchPlugin> {
        this.options = mergeWithDefaults(options);
        return MeilisearchPlugin;
    }

    /** @internal */
    async onApplicationBootstrap(): Promise<void> {
        const host = MeilisearchPlugin.options.host;
        try {
            await this.meilisearchService.checkConnection();
        } catch (e: any) {
            Logger.error(`Could not connect to Meilisearch instance at "${host}"`, loggerCtx);
            Logger.error(JSON.stringify(e), loggerCtx);
            this.healthCheckRegistryService.registerIndicatorFunction(() =>
                this.meilisearchHealthIndicator.startupCheckFailed(e.message),
            );
            return;
        }
        Logger.info(`Successfully connected to Meilisearch instance at "${host}"`, loggerCtx);

        await this.meilisearchService.createIndicesIfNotExists();
        this.healthCheckRegistryService.registerIndicatorFunction(() =>
            this.meilisearchHealthIndicator.isHealthy(),
        );

        this.eventBus.ofType(ProductEvent).subscribe(event => {
            if (event.type === 'deleted') {
                return this.meilisearchIndexService.deleteProduct(event.ctx, event.product);
            } else {
                return this.meilisearchIndexService.updateProduct(event.ctx, event.product);
            }
        });
        this.eventBus.ofType(ProductVariantEvent).subscribe(event => {
            if (event.type === 'deleted') {
                return this.meilisearchIndexService.deleteVariant(event.ctx, event.variants);
            } else {
                return this.meilisearchIndexService.updateVariants(event.ctx, event.variants);
            }
        });
        this.eventBus.ofType(AssetEvent).subscribe(event => {
            if (event.type === 'updated') {
                return this.meilisearchIndexService.updateAsset(event.ctx, event.asset);
            }
            if (event.type === 'deleted') {
                return this.meilisearchIndexService.deleteAsset(event.ctx, event.asset);
            }
        });

        this.eventBus.ofType(ProductChannelEvent).subscribe(event => {
            if (event.type === 'assigned') {
                return this.meilisearchIndexService.assignProductToChannel(
                    event.ctx,
                    event.product,
                    event.channelId,
                );
            } else {
                return this.meilisearchIndexService.removeProductFromChannel(
                    event.ctx,
                    event.product,
                    event.channelId,
                );
            }
        });

        this.eventBus.ofType(ProductVariantChannelEvent).subscribe(event => {
            if (event.type === 'assigned') {
                return this.meilisearchIndexService.assignVariantToChannel(
                    event.ctx,
                    event.productVariant.id,
                    event.channelId,
                );
            } else {
                return this.meilisearchIndexService.removeVariantFromChannel(
                    event.ctx,
                    event.productVariant.id,
                    event.channelId,
                );
            }
        });

        this.eventBus.ofType(StockMovementEvent).subscribe(event => {
            return this.meilisearchIndexService.updateVariants(
                event.ctx,
                event.stockMovements.map(m => m.productVariant),
            );
        });

        // Buffer collection modification events to batch process them
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
                return this.meilisearchIndexService.updateVariantsById(events.ctx, events.ids);
            });

        this.eventBus
            .ofType(TaxRateModificationEvent)
            .pipe(delay(1))
            .subscribe(event => {
                const defaultTaxZone = event.ctx.channel.defaultTaxZone;
                if (defaultTaxZone && idsAreEqual(defaultTaxZone.id, event.taxRate.zone.id)) {
                    return this.meilisearchService.reindex(event.ctx);
                }
            });
    }
}
