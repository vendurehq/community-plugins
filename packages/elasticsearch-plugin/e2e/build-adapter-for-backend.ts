import type { SearchClientAdapter } from '../src/adapter';
import { createElasticsearchAdapter, createOpenSearchAdapter } from '../src/adapter';


const { searchBackend, elasticsearchHost, elasticsearchPort } = require('./constants');

/**
 * Returns a **factory** that the plugin will invoke once per NestJS
 * provider (service + indexer controller). Each invocation produces a
 * fresh adapter wrapping a fresh underlying client, so tearing one
 * provider down during `onModuleDestroy` does not drain the other
 * provider's pool mid-flight (which would surface as "There are no
 * living connections" on the next request).
 *
 * Kept in its own module (deliberately free of any spec-file transitive
 * imports) so either spec file can import it without dragging the other
 * spec's top-level `ElasticsearchPlugin.init()` into scope — otherwise
 * the two specs would clobber each other's static plugin options when
 * they run in the same vitest worker.
 */
export function buildAdapterForBackend(): () => SearchClientAdapter {
    if (searchBackend === 'opensearch') {
        return () =>
            createOpenSearchAdapter({ host: elasticsearchHost, port: elasticsearchPort });
    }
    return () =>
        createElasticsearchAdapter({ host: elasticsearchHost, port: elasticsearchPort });
}
