import type {
    BulkResponseBody,
    SearchClientAdapter,
    SearchResponseBody,
    UpdateByQueryResponseBody,
} from './search-client-adapter';
import type { Client, ClientOptions } from '@opensearch-project/opensearch';


/**
 * Options accepted by `createOpenSearchAdapter`.
 *
 * Mirrors `ElasticsearchAdapterOptions` so swapping backends only touches
 * the factory call. `clientOptions` is forwarded to the
 * `@opensearch-project/opensearch` `Client` constructor and can be used
 * for AWS SigV4, custom SSL, connection pooling, etc.
 */
export interface OpenSearchAdapterOptions {
    host?: string;
    port?: number;
    clientOptions?: ClientOptions;
}

export class OpenSearchClientNotInstalledError extends Error {
    constructor() {
        super(
            'The OpenSearchAdapter requires "@opensearch-project/opensearch" to be installed as a ' +
                'peer dependency. Install it alongside @vendure-community/elasticsearch-plugin with ' +
                'your package manager, e.g. `npm install @opensearch-project/opensearch`.',
        );
        this.name = 'OpenSearchClientNotInstalledError';
    }
}

function loadOpenSearchClient(): typeof import('@opensearch-project/opensearch') {
    try {

        return require('@opensearch-project/opensearch');
    } catch (e) {
        throw new OpenSearchClientNotInstalledError();
    }
}

/**
 * `SearchClientAdapter` backed by `@opensearch-project/opensearch`. The OS
 * client already wraps every response in `{ body, statusCode, headers }`,
 * so the adapter is mostly a thin pass-through.
 */
export class OpenSearchAdapter implements SearchClientAdapter {
    readonly indices: SearchClientAdapter['indices'];
    private closePromise: Promise<void> | undefined;

    constructor(private readonly client: Client) {
        this.indices = {
            create: async ({ index, body }) => {
                const result = await this.client.indices.create({ index, body });
                return { body: result.body };
            },
            delete: async ({ index }) => {
                const result = await this.client.indices.delete({ index });
                return { body: result.body };
            },
            exists: async ({ index }) => {
                const result = await this.client.indices.exists({ index });
                return { body: Boolean(result.body) };
            },
            existsAlias: async ({ name }) => {
                const result = await this.client.indices.existsAlias({ name });
                return { body: Boolean(result.body) };
            },
            getAlias: async ({ name, index }) => {
                const result = await this.client.indices.getAlias({ name, index });
                return { body: result.body as Record<string, any> };
            },
            getMapping: async ({ index }) => {
                const result = await this.client.indices.getMapping({ index });
                return { body: result.body as Record<string, any> };
            },
            getSettings: async ({ index }) => {
                const result = await this.client.indices.getSettings({ index });
                return { body: result.body as Record<string, any> };
            },
            putAlias: async ({ index, name, body }) => {
                const result = await this.client.indices.putAlias({ index, name, body });
                return { body: result.body };
            },
            putSettings: async ({ index, body }) => {
                const result = await this.client.indices.putSettings({ index, body });
                return { body: result.body };
            },
            refresh: async ({ index }) => {
                const result = await this.client.indices.refresh({ index });
                return { body: result.body };
            },
            updateAliases: async ({ body }) => {
                const result = await this.client.indices.updateAliases({ body });
                return { body: result.body };
            },
        };
    }

    async ping(options?: { requestTimeout?: number }): Promise<{ body: boolean }> {
        const result = await this.client.ping({}, options ?? {});
        return { body: Boolean(result.body) };
    }

    async close(): Promise<void> {
        // `onModuleDestroy` fires on every provider that holds the adapter
        // (the service and the indexer controller), so `close()` is called
        // more than once. Memoise the underlying client's close so the
        // second caller just awaits the same promise instead of re-entering
        // a close on an already-torn-down client. The OS client in
        // particular hangs on the second invocation otherwise.
        if (!this.closePromise) {
            this.closePromise = this.client.close();
        }
        await this.closePromise;
    }

    async search<T = unknown>(params: {
        index: string;
        body: any;
    }): Promise<{ body: SearchResponseBody<T> }> {
        const result = await this.client.search(params);
        return { body: result.body as unknown as SearchResponseBody<T> };
    }

    async bulk(params: { body: any[] }): Promise<{ body: BulkResponseBody }> {
        const result = await this.client.bulk(params);
        return { body: result.body as unknown as BulkResponseBody };
    }

    async updateByQuery(params: {
        index: string;
        body: any;
        refresh?: boolean;
    }): Promise<{ body: UpdateByQueryResponseBody }> {
        const result = await this.client.updateByQuery(params);
        // The OS client narrows updateByQuery to a union including the async-
        // task variant (`{ task?: string }`). Cast once here so downstream
        // code can read `failures` without gymnastics.
        return { body: result.body as unknown as UpdateByQueryResponseBody };
    }

    async deleteByQuery(params: {
        index: string;
        body: any;
        refresh?: boolean;
    }): Promise<{ body: any }> {
        const result = await this.client.deleteByQuery(params);
        return { body: result.body };
    }

    getRawClient(): Client {
        return this.client;
    }
}

/**
 * Factory that returns an `OpenSearchAdapter` ready to pass to
 * `ElasticsearchPlugin.init({ adapter: ... })`.
 *
 * Throws `OpenSearchClientNotInstalledError` if
 * `@opensearch-project/opensearch` is not installed.
 */
export function createOpenSearchAdapter(options: OpenSearchAdapterOptions = {}): OpenSearchAdapter {
    const { Client } = loadOpenSearchClient();
    const host = options.host ?? 'http://localhost';
    const port = options.port ?? 9200;
    const node = options.clientOptions?.node ?? `${host}:${port}`;
    const client = new Client({
        node,
        ...(options.clientOptions as any),
    });
    return new OpenSearchAdapter(client);
}
