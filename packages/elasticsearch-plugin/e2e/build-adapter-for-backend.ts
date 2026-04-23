import { createElasticsearchAdapter, createOpenSearchAdapter } from '../src/adapter';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { searchBackend, elasticsearchHost, elasticsearchPort } = require('./constants');

/**
 * Build an adapter for the currently-configured search backend. Kept in its
 * own module (deliberately free of any spec-file transitive imports) so
 * either spec file can import it without dragging the other spec's
 * top-level `ElasticsearchPlugin.init()` into scope — otherwise the two
 * specs would clobber each other's static plugin options when they run in
 * the same vitest worker.
 */
export function buildAdapterForBackend() {
    if (searchBackend === 'opensearch') {
        return createOpenSearchAdapter({ host: elasticsearchHost, port: elasticsearchPort });
    }
    return createElasticsearchAdapter({ host: elasticsearchHost, port: elasticsearchPort });
}
