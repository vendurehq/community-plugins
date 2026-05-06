/**
 * Pluggable search backend for the Elasticsearch plugin. Lets the same
 * service/indexer/resolvers code drive either Elasticsearch or OpenSearch.
 *
 * Every method returns a normalised `{ body }` envelope so downstream code
 * doesn't need to know whether it is talking to the `@elastic/elasticsearch`
 * or `@opensearch-project/opensearch` client.
 *
 * The interface is intentionally narrow: only the operations actually
 * exercised by the plugin are exposed. Callers that need backend-specific
 * escape hatches can reach the native client via `getRawClient()`.
 */
export interface SearchClientAdapter {
    /** Pings the server, primarily used for health checks. */
    ping(options?: { requestTimeout?: number }): Promise<{ body: boolean }>;

    /** Closes the underlying client and releases any open connections. */
    close(): Promise<void>;

    search<T = unknown>(params: {
        index: string;
        body: any;
    }): Promise<{ body: SearchResponseBody<T> }>;

    bulk(params: {
        index?: string;
        refresh?: boolean | 'wait_for';
        body: any[];
    }): Promise<{ body: BulkResponseBody }>;

    updateByQuery(params: {
        index: string;
        body: any;
        refresh?: boolean;
    }): Promise<{ body: UpdateByQueryResponseBody }>;

    deleteByQuery(params: {
        index: string;
        body: any;
        refresh?: boolean;
    }): Promise<{ body: any }>;

    indices: {
        create(params: { index: string; body?: any }): Promise<{ body: any }>;
        delete(params: { index: string | string[] }): Promise<{ body: any }>;
        exists(params: { index: string | string[] }): Promise<{ body: boolean }>;
        existsAlias(params: { name: string }): Promise<{ body: boolean }>;
        getAlias(params: { name?: string; index?: string }): Promise<{ body: Record<string, any> }>;
        getMapping(params: { index: string }): Promise<{ body: Record<string, any> }>;
        getSettings(params: { index: string }): Promise<{ body: Record<string, any> }>;
        putAlias(params: { index: string; name: string; body?: any }): Promise<{ body: any }>;
        putSettings(params: { index: string | string[]; body: any }): Promise<{ body: any }>;
        refresh(params: { index: string | string[] }): Promise<{ body: any }>;
        updateAliases(params: { body: any }): Promise<{ body: any }>;
    };

    /**
     * Returns the underlying native client (`@elastic/elasticsearch` or
     * `@opensearch-project/opensearch`). Escape hatch for backend-specific
     * features (OS k-NN, OS CCR, ES ESQL, etc.) that are outside the plugin's
     * normalised surface.
     */
    getRawClient(): unknown;
}

export interface SearchResponseBody<T = unknown> {
    took?: number;
    timed_out?: boolean;
    _shards?: {
        total: number;
        successful: number;
        skipped?: number;
        failed: number;
    };
    hits: {
        total: number | { value: number; relation: string };
        max_score?: number | null;
        hits: Array<{
            _index: string;
            _id: string;
            _score: number | null;
            _source: T;
            sort?: any;
            fields?: Record<string, any>;
        }>;
    };
    aggregations?: Record<string, any>;
}

export interface BulkResponseBody {
    took: number;
    errors: boolean;
    items: Array<Record<string, any>>;
}

export interface UpdateByQueryResponseBody {
    took?: number;
    timed_out?: boolean;
    total?: number;
    updated?: number;
    deleted?: number;
    failures?: Array<{
        cause: { type: string; reason: string };
        [key: string]: any;
    }>;
    task?: string;
}
