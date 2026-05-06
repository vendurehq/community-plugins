export type { SearchClientAdapter } from './search-client-adapter';
export {
    ElasticsearchAdapter,
    ElasticsearchAdapterOptions,
    ElasticsearchClientNotInstalledError,
    createElasticsearchAdapter,
} from './elasticsearch-adapter';
export {
    OpenSearchAdapter,
    OpenSearchAdapterOptions,
    OpenSearchClientNotInstalledError,
    createOpenSearchAdapter,
} from './opensearch-adapter';
