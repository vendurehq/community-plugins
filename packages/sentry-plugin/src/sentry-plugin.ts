import { SentryModule } from '@sentry/nestjs/setup';
import { PluginCommonModule, VendurePlugin } from '@vendure/core';

import { SentryAdminTestResolver } from './api/admin-test.resolver';
import { testApiExtensions } from './api/api-extensions';
import { ErrorTestService } from './api/error-test.service';
import { SENTRY_PLUGIN_OPTIONS } from './constants';
import { SentryErrorHandlerStrategy } from './sentry-error-handler-strategy';
import { SentryService } from './sentry.service';
import { SentryPluginOptions } from './types';

const SentryOptionsProvider = {
    provide: SENTRY_PLUGIN_OPTIONS,
    useFactory: () => SentryPlugin.options,
};

/**
 * @description
 * This plugin integrates the [Sentry](https://sentry.io) error tracking & performance monitoring
 * service with your Vendure server. In addition to capturing errors, it also provides built-in
 * support for [tracing](https://docs.sentry.io/product/sentry-basics/concepts/tracing/) as well as
 * enriching your Sentry events with additional context about the request.
 *
 * @docsCategory SentryPlugin
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [SentryOptionsProvider, SentryService, ErrorTestService],
    configuration: config => {
        config.systemOptions.errorHandlers.push(new SentryErrorHandlerStrategy());
        config.plugins.push(SentryModule.forRoot());
        return config;
    },
    adminApiExtensions: {
        schema: () => (SentryPlugin.options.includeErrorTestMutation ? testApiExtensions : undefined),
        resolvers: () => (SentryPlugin.options.includeErrorTestMutation ? [SentryAdminTestResolver] : []),
    },
    exports: [SentryService],
    compatibility: '^3.0.0',
})
export class SentryPlugin {
    static options: SentryPluginOptions = {} as any;

    static init(options?: SentryPluginOptions) {
        this.options = options ?? {};
        return this;
    }
}
