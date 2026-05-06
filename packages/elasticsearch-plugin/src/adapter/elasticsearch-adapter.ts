import type {
    BulkResponseBody,
    SearchClientAdapter,
    SearchResponseBody,
    UpdateByQueryResponseBody,
} from './search-client-adapter';
import type { Client, ClientOptions } from '@elastic/elasticsearch';


/**
 * Options accepted by `createElasticsearchAdapter`.
 *
 * All backend-specific configuration for the ES client lives here, so the
 * adapter-factory call is the one place a consumer describes their ES
 * connection. None of this leaks into the plugin's top-level `init()`.
 */
export interface ElasticsearchAdapterOptions {
    /**
     * Host URL (without port), e.g. `http://localhost`. Combined with
     * `port` to form the node URL unless `clientOptions.node` / `nodes`
     * is provided.
     */
    host?: string;
    port?: number;
    /**
     * Full options object forwarded to the underlying
     * `@elastic/elasticsearch` `Client` constructor. When set, `node` /
     * `nodes` here takes precedence over `host` + `port`.
     */
    clientOptions?: ClientOptions;
}

/**
 * Error thrown when the `@elastic/elasticsearch` peer dependency is not
 * installed. The plugin declares the client as an optional peer so consumers
 * only install the backend they actually use.
 */
export class ElasticsearchClientNotInstalledError extends Error {
    constructor() {
        super(
            'The ElasticsearchAdapter requires "@elastic/elasticsearch" to be installed as a peer ' +
                'dependency. Install it alongside @vendure-community/elasticsearch-plugin with your ' +
                'package manager, e.g. `npm install @elastic/elasticsearch`.',
        );
        this.name = 'ElasticsearchClientNotInstalledError';
    }
}


function loadElasticsearchClient(): typeof import('@elastic/elasticsearch') {
    try {
        // Using require() rather than a static import so the package stays an
        // optional peer: if a consumer only uses OpenSearch, they never need
        // @elastic/elasticsearch installed.

        return require('@elastic/elasticsearch');
    } catch (e) {
        throw new ElasticsearchClientNotInstalledError();
    }
}

/**
 * `SearchClientAdapter` backed by the official `@elastic/elasticsearch`
 * client. All calls go through `{ meta: true }` so responses return the
 * `{ body, statusCode, headers }` envelope the rest of the plugin expects.
 */
export class ElasticsearchAdapter implements SearchClientAdapter {
    readonly indices: SearchClientAdapter['indices'];
    private closePromise: Promise<void> | undefined;

    constructor(private readonly client: Client) {
        this.indices = {
            create: async ({ index, body }) => {
                const result = await this.client.indices.create({ index, body }, { meta: true });
                return { body: result.body };
            },
            delete: async ({ index }) => {
                const result = await this.client.indices.delete({ index }, { meta: true });
                return { body: result.body };
            },
            exists: async ({ index }) => {
                const result = await this.client.indices.exists({ index }, { meta: true });
                return { body: result.body };
            },
            existsAlias: async ({ name }) => {
                const result = await this.client.indices.existsAlias({ name }, { meta: true });
                return { body: result.body };
            },
            getAlias: async ({ name, index }) => {
                const result = await this.client.indices.getAlias({ name, index }, { meta: true });
                return { body: result.body as Record<string, any> };
            },
            getMapping: async ({ index }) => {
                const result = await this.client.indices.getMapping({ index }, { meta: true });
                return { body: result.body as Record<string, any> };
            },
            getSettings: async ({ index }) => {
                const result = await this.client.indices.getSettings({ index }, { meta: true });
                return { body: result.body as Record<string, any> };
            },
            putAlias: async ({ index, name, body }) => {
                const result = await this.client.indices.putAlias(
                    { index, name, body },
                    { meta: true },
                );
                return { body: result.body };
            },
            putSettings: async ({ index, body }) => {
                const result = await this.client.indices.putSettings(
                    { index, body },
                    { meta: true },
                );
                return { body: result.body };
            },
            refresh: async ({ index }) => {
                const result = await this.client.indices.refresh({ index }, { meta: true });
                return { body: result.body };
            },
            updateAliases: async ({ body }) => {
                const result = await this.client.indices.updateAliases({ body }, { meta: true });
                return { body: result.body };
            },
        };
    }

    async ping(options?: { requestTimeout?: number }): Promise<{ body: boolean }> {
        const result = await this.client.ping({}, { meta: true, ...(options ?? {}) });
        return { body: result.body };
    }

    async close(): Promise<void> {
        // `onModuleDestroy` fires on every provider that holds the adapter
        // (the service and the indexer controller), so `close()` is called
        // more than once. Memoise the underlying client's close so the
        // second caller just awaits the same promise instead of re-entering
        // a close on an already-torn-down client.
        if (!this.closePromise) {
            this.closePromise = this.client.close();
        }
        await this.closePromise;
    }

    async search<T = unknown>(params: {
        index: string;
        body: any;
    }): Promise<{ body: SearchResponseBody<T> }> {
        const result = await this.client.search(params, { meta: true });
        return { body: result.body as unknown as SearchResponseBody<T> };
    }

    async bulk(params: { body: any[] }): Promise<{ body: BulkResponseBody }> {
        const result = await this.client.bulk(params, { meta: true });
        return { body: result.body as unknown as BulkResponseBody };
    }

    async updateByQuery(params: {
        index: string;
        body: any;
        refresh?: boolean;
    }): Promise<{ body: UpdateByQueryResponseBody }> {
        const result = await this.client.updateByQuery(params, { meta: true });
        return { body: result.body as unknown as UpdateByQueryResponseBody };
    }

    async deleteByQuery(params: {
        index: string;
        body: any;
        refresh?: boolean;
    }): Promise<{ body: any }> {
        const result = await this.client.deleteByQuery(params, { meta: true });
        return { body: result.body };
    }

    getRawClient(): Client {
        return this.client;
    }
}

/**
 * Factory that returns an `ElasticsearchAdapter` ready to pass to
 * `ElasticsearchPlugin.init({ adapter: ... })`.
 *
 * Throws `ElasticsearchClientNotInstalledError` if `@elastic/elasticsearch`
 * is not installed.
 */
export function createElasticsearchAdapter(
    options: ElasticsearchAdapterOptions = {},
): ElasticsearchAdapter {
    const { Client } = loadElasticsearchClient();
    const host = options.host ?? 'http://localhost';
    const port = options.port ?? 9200;
    const node = options.clientOptions?.node ?? `${host}:${port}`;
    const client = new Client({
        node,
        // Cast keeps the shape tolerant to minor type drift between ES client
        // minor versions without blocking the plugin's TypeScript build.
        ...(options.clientOptions as any),
    });
    return new ElasticsearchAdapter(client);
}
