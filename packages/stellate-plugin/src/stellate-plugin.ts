import { Inject, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventBus, Injector, PluginCommonModule, VendurePlugin } from '@vendure/core';
import { buffer, debounceTime } from 'rxjs/operators';

import { shopApiExtensions } from './api/api-extensions';
import { SearchResponseFieldResolver } from './api/search-response.resolver';
import { STELLATE_PLUGIN_OPTIONS } from './constants';
import { StellateService } from './service/stellate.service';
import { StellatePluginOptions } from './types';

const StellateOptionsProvider = {
    provide: STELLATE_PLUGIN_OPTIONS,
    useFactory: () => StellatePlugin.options,
};

/**
 * @description
 * A plugin to integrate the [Stellate](https://stellate.co/) GraphQL caching service with your Vendure server.
 * The main purpose of this plugin is to ensure that cached data gets correctly purged in
 * response to events inside Vendure. For example, changes to a Product's description should
 * purge any associated record for that Product in Stellate's cache.
 *
 * @since 2.1.5
 * @docsCategory StellatePlugin
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [StellateOptionsProvider, StellateService],
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [SearchResponseFieldResolver],
    },
    compatibility: '^3.0.0',
})
export class StellatePlugin implements OnApplicationBootstrap {
    static options: StellatePluginOptions;

    static init(options: StellatePluginOptions) {
        this.options = options;
        return this;
    }

    constructor(
        @Inject(STELLATE_PLUGIN_OPTIONS) private options: StellatePluginOptions,
        private eventBus: EventBus,
        private stellateService: StellateService,
        private moduleRef: ModuleRef,
    ) {}

    onApplicationBootstrap() {
        const injector = new Injector(this.moduleRef);

        for (const purgeRule of this.options.purgeRules ?? []) {
            const source$ = this.eventBus.ofType(purgeRule.eventType);
            source$
                .pipe(
                    buffer(
                        source$.pipe(
                            debounceTime(purgeRule.bufferTimeMs ?? this.options.defaultBufferTimeMs ?? 2000),
                        ),
                    ),
                )
                .subscribe(events =>
                    purgeRule.handle({ events, injector, stellateService: this.stellateService }),
                );
        }
    }
}
