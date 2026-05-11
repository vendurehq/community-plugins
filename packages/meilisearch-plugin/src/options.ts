import {
    DeepRequired,
    EntityRelationPaths,
    ID,
    Injector,
    LanguageCode,
    Product,
    ProductVariant,
    RequestContext,
} from '@vendure/core';
import deepmerge from 'deepmerge';

import {
    CustomMapping,
    GraphQlPrimitive,
    MeilisearchSearchInput,
    PrimitiveTypeVariations,
} from './types';

/**
 * @description
 * Configuration for typo tolerance behavior.
 */
export interface TypoToleranceConfig {
    /**
     * @description
     * Whether typo tolerance is enabled. Defaults to `true`.
     */
    enabled?: boolean;
    /**
     * @description
     * Minimum word size for 1 typo to be allowed. Defaults to 5.
     */
    minWordSizeForOneTypo?: number;
    /**
     * @description
     * Minimum word size for 2 typos to be allowed. Defaults to 9.
     */
    minWordSizeForTwoTypos?: number;
    /**
     * @description
     * A list of words for which typo tolerance is disabled.
     * Useful for brand names or technical terms that must be exact.
     *
     * @example
     * ```ts
     * ['iPhone', 'Samsung', 'MacBook']
     * ```
     */
    disableOnWords?: string[];
    /**
     * @description
     * A list of attributes for which typo tolerance is disabled.
     *
     * @example
     * ```ts
     * ['sku']  // SKU must match exactly
     * ```
     */
    disableOnAttributes?: string[];
}

/**
 * @description
 * Configuration options for the MeilisearchPlugin.
 *
 * @example
 * ```ts
 * MeilisearchPlugin.init({
 *   host: 'http://localhost:7700',
 *   apiKey: 'masterKey',
 *   synonyms: {
 *     phone: ['mobile', 'smartphone'],
 *     laptop: ['notebook'],
 *   },
 * })
 * ```
 *
 * @docsCategory MeilisearchPlugin
 */
export interface MeilisearchOptions {
    /**
     * @description
     * The host URL of the Meilisearch server.
     *
     * @default 'http://localhost:7700'
     */
    host?: string;
    /**
     * @description
     * The API key for the Meilisearch server.
     * This is the master key or admin key used for indexing operations.
     *
     * @default ''
     */
    apiKey?: string;
    /**
     * @description
     * Maximum amount of attempts made to connect to the Meilisearch server on startup.
     *
     * @default 10
     */
    connectionAttempts?: number;
    /**
     * @description
     * Interval in milliseconds between attempts to connect to the Meilisearch server on startup.
     *
     * @default 5000
     */
    connectionAttemptInterval?: number;
    /**
     * @description
     * Prefix for the indices created by the plugin.
     *
     * @default 'vendure-'
     */
    indexPrefix?: string;
    /**
     * @description
     * Products limit chunk size for each loop iteration when indexing products.
     *
     * @default 2500
     */
    reindexProductsChunkSize?: number;
    /**
     * @description
     * Batch size for document additions during reindexing.
     * Meilisearch handles documents in batches for optimal performance.
     *
     * @default 1000
     */
    reindexBatchSize?: number;
    /**
     * @description
     * Configuration of the internal Meilisearch search query.
     */
    searchConfig?: SearchConfig;
    /**
     * @description
     * Custom product mappings for additional data in the search index.
     */
    customProductMappings?: {
        [fieldName: string]: CustomMapping<
            [Product, ProductVariant[], LanguageCode, Injector, RequestContext]
        >;
    };
    /**
     * @description
     * Custom product variant mappings for additional data in the search index.
     */
    customProductVariantMappings?: {
        [fieldName: string]: CustomMapping<[ProductVariant, LanguageCode, Injector, RequestContext]>;
    };
    /**
     * @description
     * If set to `true`, updates to Products, ProductVariants and Collections will not immediately
     * trigger an update to the search index. Instead, all these changes will be buffered and will
     * only be run via a call to the `runPendingSearchIndexUpdates` mutation in the Admin API.
     *
     * @default false
     */
    bufferUpdates?: boolean;
    /**
     * @description
     * Additional product relations that will be fetched from DB while reindexing.
     *
     * @default []
     */
    hydrateProductRelations?: Array<EntityRelationPaths<Product>>;
    /**
     * @description
     * Additional variant relations that will be fetched from DB while reindexing.
     *
     * @default []
     */
    hydrateProductVariantRelations?: Array<EntityRelationPaths<ProductVariant>>;
    /**
     * @description
     * Allows the `SearchInput` type to be extended with new input fields.
     *
     * @default {}
     */
    extendSearchInputType?: {
        [name: string]: PrimitiveTypeVariations<GraphQlPrimitive>;
    };
    /**
     * @description
     * Adds a list of sort parameters.
     *
     * @default []
     */
    extendSearchSortType?: string[];

    // ───────────────────────────── Relevancy Tuning ─────────────────────────────

    /**
     * @description
     * A map of synonyms. Each key is a word, and its value is an array of
     * synonymous words. This allows users to find products regardless of
     * which synonym they use.
     *
     * @example
     * ```ts
     * synonyms: {
     *   phone: ['mobile', 'smartphone', 'cellphone'],
     *   laptop: ['notebook', 'portable computer'],
     *   tv: ['television', 'monitor', 'screen'],
     * }
     * ```
     *
     * @default undefined (no synonyms)
     */
    synonyms?: Record<string, string[]>;

    /**
     * @description
     * A list of words to ignore during search. Common stop words like
     * "the", "a", "is" can be filtered out for cleaner results.
     *
     * @example
     * ```ts
     * stopWords: ['the', 'a', 'an', 'is', 'for', 'and', 'of', 'to', 'in']
     * ```
     *
     * @default undefined (no stop words)
     */
    stopWords?: string[];

    /**
     * @description
     * Custom ranking rules for controlling how search results are ordered.
     * Meilisearch applies these rules in order using a bucket sort algorithm -
     * the first rule has the most impact.
     *
     * Built-in rules: `'words'`, `'typo'`, `'proximity'`, `'attribute'`, `'sort'`, `'exactness'`
     *
     * You can also add custom ranking rules using attribute names followed by `:asc` or `:desc`.
     *
     * @example
     * ```ts
     * // Prioritize in-stock products, then sort by price
     * rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'productInStock:desc']
     * ```
     *
     * @default undefined (Meilisearch defaults)
     */
    rankingRules?: string[];

    /**
     * @description
     * Configuration for typo tolerance. Allows you to control how Meilisearch
     * handles misspellings in search queries.
     *
     * @example
     * ```ts
     * typoTolerance: {
     *   enabled: true,
     *   disableOnAttributes: ['sku'],  // SKU must match exactly
     *   disableOnWords: ['iPhone'],     // Brand names must be exact
     *   minWordSizeForOneTypo: 4,
     *   minWordSizeForTwoTypos: 8,
     * }
     * ```
     *
     * @default undefined (Meilisearch defaults: typo tolerance enabled)
     */
    typoTolerance?: TypoToleranceConfig;
}

/**
 * @description
 * Matching strategy used by Meilisearch to match query terms.
 *
 * - `'last'` - Returns documents containing all the query terms first, then
 *   those with fewer terms. This is the default strategy.
 * - `'all'` - Only returns documents that contain all query terms.
 *   Documents missing any query terms are not returned.
 * - `'frequency'` - Returns documents containing the most frequent query terms first.
 *   Less common terms are prioritized as they carry more meaning.
 */
export type MatchingStrategy = 'last' | 'all' | 'frequency';

/**
 * @description
 * Configuration options for the internal Meilisearch query generated when performing a search.
 *
 * @example
 * ```ts
 * searchConfig: {
 *   // Show highlighting in results
 *   attributesToHighlight: ['productName', 'description'],
 *   highlightPreTag: '<mark>',
 *   highlightPostTag: '</mark>',
 *
 *   // Crop long descriptions
 *   attributesToCrop: ['description'],
 *   cropLength: 30,
 *
 *   // Only return results that match all query terms
 *   matchingStrategy: 'all',
 *
 *   // Filter out low-relevance results
 *   rankingScoreThreshold: 0.3,
 *
 *   // Show ranking scores for debugging
 *   showRankingScore: true,
 * }
 * ```
 */
export interface SearchConfig {
    /**
     * @description
     * The maximum number of FacetValues to return from the search query.
     *
     * @default 50
     */
    facetValueMaxSize?: number;
    /**
     * @description
     * The maximum number of Collections to return from the search query.
     *
     * @default 50
     */
    collectionMaxSize?: number;
    /**
     * @description
     * The maximum number of totalItems to return from the search query.
     *
     * @default 10000
     */
    totalItemsMaxSize?: number;
    /**
     * @description
     * The interval used to group search results into price range buckets.
     *
     * @default 1000
     */
    priceRangeBucketInterval?: number;

    // ───────────────────────────── Matching & Relevancy ─────────────────────────────

    /**
     * @description
     * Strategy used to match query terms within documents.
     *
     * - `'last'` (default) - Returns documents with all query terms first, then
     *   progressively returns those missing less important terms.
     * - `'all'` - Only returns documents containing **all** query terms.
     *   Useful for strict/exact matching.
     * - `'frequency'` - Prioritizes less common (more meaningful) query terms
     *   and returns documents containing those first.
     *
     * @default 'last'
     *
     * @example
     * ```ts
     * // Only return products that match ALL search terms
     * matchingStrategy: 'all'
     * ```
     */
    matchingStrategy?: MatchingStrategy;

    /**
     * @description
     * Restrict search to the specified attributes only. Documents are still
     * returned with all their fields, but only the listed attributes are
     * searched for matches.
     *
     * If not set, all searchable attributes are searched.
     *
     * @example
     * ```ts
     * // Only search in product name and SKU, ignore description
     * attributesToSearchOn: ['productName', 'sku']
     * ```
     *
     * @default undefined (all searchable attributes)
     */
    attributesToSearchOn?: string[];

    /**
     * @description
     * Attributes to display in the returned documents. Use `['*']` to return
     * all attributes (default).
     *
     * @default undefined (all attributes)
     */
    attributesToRetrieve?: string[];

    /**
     * @description
     * Minimum ranking score threshold (0.0 to 1.0). Documents with scores
     * below this value are excluded from search results.
     *
     * Useful for filtering out low-relevance results, especially with
     * AI-powered hybrid search where semantic matches may be weak.
     *
     * @example
     * ```ts
     * // Only return results with at least 30% relevance
     * rankingScoreThreshold: 0.3
     * ```
     *
     * @default undefined (no threshold)
     */
    rankingScoreThreshold?: number;

    // ───────────────────────────── Highlighting ─────────────────────────────

    /**
     * @description
     * Attributes whose matching terms should be highlighted in the response.
     * Highlighted results are returned in the `_formatted` field of each hit.
     *
     * Use `['*']` to highlight all searchable attributes.
     *
     * @example
     * ```ts
     * attributesToHighlight: ['productName', 'description']
     * ```
     *
     * @default undefined (no highlighting)
     */
    attributesToHighlight?: string[];

    /**
     * @description
     * HTML/string tag inserted **before** a highlighted term.
     *
     * @default '<em>'
     *
     * @example
     * ```ts
     * highlightPreTag: '<mark class="highlight">'
     * ```
     */
    highlightPreTag?: string;

    /**
     * @description
     * HTML/string tag inserted **after** a highlighted term.
     *
     * @default '</em>'
     *
     * @example
     * ```ts
     * highlightPostTag: '</mark>'
     * ```
     */
    highlightPostTag?: string;

    // ───────────────────────────── Cropping ─────────────────────────────

    /**
     * @description
     * Attributes whose values should be cropped (truncated around matched terms).
     * Cropped results are returned in the `_formatted` field of each hit.
     *
     * Each entry can optionally include a custom crop length:
     * `'description:20'` crops the description to 20 words.
     *
     * Use `['*']` to crop all searchable attributes.
     *
     * @example
     * ```ts
     * attributesToCrop: ['description', 'overview:15']
     * ```
     *
     * @default undefined (no cropping)
     */
    attributesToCrop?: string[];

    /**
     * @description
     * Default maximum length (in words) of cropped attribute values.
     * Individual attributes can override this via `'attribute:length'` syntax
     * in `attributesToCrop`.
     *
     * @default 10
     */
    cropLength?: number;

    /**
     * @description
     * String used to mark crop boundaries (ellipsis marker).
     *
     * @default '…'
     *
     * @example
     * ```ts
     * cropMarker: '...'
     * ```
     */
    cropMarker?: string;

    // ───────────────────────────── Debug / Scoring ─────────────────────────────

    /**
     * @description
     * When `true`, adds a `_matchesPosition` field to each hit showing the
     * exact byte offsets where query terms were found. Useful for building
     * custom highlighting on the client side.
     *
     * @default false
     */
    showMatchesPosition?: boolean;

    /**
     * @description
     * When `true`, includes a `_rankingScore` field (0.0 to 1.0) in each hit
     * representing the global relevance score. Useful for debugging relevance
     * and understanding why certain results rank higher.
     *
     * @default false
     */
    showRankingScore?: boolean;

    /**
     * @description
     * When `true`, includes a `_rankingScoreDetails` field in each hit with
     * a detailed breakdown of the score per ranking rule (words, typo,
     * proximity, attribute, sort, exactness, etc.).
     *
     * Useful for fine-tuning ranking rules and understanding relevance.
     *
     * @default false
     */
    showRankingScoreDetails?: boolean;

    // ───────────────────────────── Hooks ─────────────────────────────

    /**
     * @description
     * Allows modification of the whole search query before it is sent to Meilisearch.
     * This is the most powerful hook - you can override or add any Meilisearch
     * search parameter here.
     *
     * @example
     * ```ts
     * mapQuery: (query, input, searchConfig, channelId, enabledOnly, ctx) => {
     *   // Add custom filter based on user role
     *   if (ctx.activeUser?.roles?.includes('wholesale')) {
     *     query.filter += ' AND wholesaleOnly = true';
     *   }
     *   return query;
     * }
     * ```
     */
    mapQuery?: (
        query: any,
        input: MeilisearchSearchInput,
        searchConfig: MeilisearchRuntimeOptions['searchConfig'],
        channelId: ID,
        enabledOnly: boolean,
        ctx: RequestContext,
    ) => any;
    /**
     * @description
     * Allows extending the sort parameter of the Meilisearch query.
     */
    mapSort?: (sort: string[], input: MeilisearchSearchInput) => string[];
}

/**
 * The required core search config fields that always have defaults.
 */
export interface SearchConfigDefaults {
    facetValueMaxSize: number;
    collectionMaxSize: number;
    totalItemsMaxSize: number;
    priceRangeBucketInterval: number;
    mapQuery: (
        query: any,
        input: MeilisearchSearchInput,
        searchConfig: SearchConfigDefaults,
        channelId: ID,
        enabledOnly: boolean,
        ctx: RequestContext,
    ) => any;
    mapSort: (sort: string[], input: MeilisearchSearchInput) => string[];
}

export type MeilisearchRuntimeOptions = DeepRequired<
    Omit<MeilisearchOptions, 'synonyms' | 'stopWords' | 'rankingRules' | 'typoTolerance' | 'searchConfig'>
> & {
    searchConfig: SearchConfigDefaults & Omit<SearchConfig, keyof SearchConfigDefaults>;
    synonyms?: Record<string, string[]>;
    stopWords?: string[];
    rankingRules?: string[];
    typoTolerance?: TypoToleranceConfig;
};

export const defaultOptions: MeilisearchRuntimeOptions = {
    host: 'http://localhost:7700',
    apiKey: '',
    connectionAttempts: 10,
    connectionAttemptInterval: 5000,
    indexPrefix: 'vendure-',
    reindexProductsChunkSize: 2500,
    reindexBatchSize: 1000,
    searchConfig: {
        facetValueMaxSize: 50,
        collectionMaxSize: 50,
        totalItemsMaxSize: 10000,
        priceRangeBucketInterval: 1000,
        mapQuery: query => query,
        mapSort: sort => sort,
    },
    customProductMappings: {},
    customProductVariantMappings: {},
    bufferUpdates: false,
    hydrateProductRelations: [],
    hydrateProductVariantRelations: [],
    extendSearchInputType: {},
    extendSearchSortType: [],
};

export function mergeWithDefaults(userOptions: MeilisearchOptions): MeilisearchRuntimeOptions {
    const { synonyms, stopWords, rankingRules, typoTolerance, searchConfig, ...rest } = userOptions;
    const merged = deepmerge(defaultOptions, rest) as MeilisearchRuntimeOptions;
    // Deep merge searchConfig to preserve user overrides alongside defaults
    if (searchConfig) {
        merged.searchConfig = deepmerge(defaultOptions.searchConfig, searchConfig) as MeilisearchRuntimeOptions['searchConfig'];
    }
    // These optional configs are not deep-merged to avoid weird array merging behavior
    if (synonyms) merged.synonyms = synonyms;
    if (stopWords) merged.stopWords = stopWords;
    if (rankingRules) merged.rankingRules = rankingRules;
    if (typoTolerance) merged.typoTolerance = typoTolerance;
    return merged;
}
