import { Logger } from '@vendure/core';
import { MeiliSearch } from 'meilisearch';

import { loggerCtx } from '../constants';
import { MeilisearchRuntimeOptions } from '../options';

/**
 * Expands a synonym map so that every word in a group maps to every other word
 * in that group (bidirectional). This means the user only needs to define
 * `laptop: ['notebook']` and the reverse `notebook: ['laptop']` is generated
 * automatically.
 *
 * Overlapping groups are merged and a word never maps to itself.
 */
export function expandSynonymsBidirectional(
    synonyms: Record<string, string[]>,
): Record<string, string[]> {
    const expanded: Record<string, Set<string>> = {};
    for (const [key, values] of Object.entries(synonyms)) {
        const group = [key, ...values];
        for (const word of group) {
            if (!expanded[word]) {
                expanded[word] = new Set();
            }
            for (const other of group) {
                if (other !== word) {
                    expanded[word].add(other);
                }
            }
        }
    }
    const result: Record<string, string[]> = {};
    for (const [word, synonymSet] of Object.entries(expanded)) {
        result[word] = Array.from(synonymSet);
    }
    return result;
}

/**
 * Creates and returns a MeiliSearch client instance.
 */
export function getClient(options: Pick<MeilisearchRuntimeOptions, 'host' | 'apiKey'>): MeiliSearch {
    return new MeiliSearch({
        host: options.host,
        apiKey: options.apiKey,
    });
}

/**
 * Returns a sanitized index UID for Meilisearch.
 * Meilisearch only allows alphanumeric characters, hyphens, and underscores.
 */
export function getIndexUid(prefix: string, indexName: string): string {
    const raw = `${prefix}${indexName}`;
    return raw.replace(/\./g, '-').replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Creates a Meilisearch index if it does not already exist.
 */
export async function createIndex(
    client: MeiliSearch,
    indexUid: string,
    primaryKey: string = 'id',
): Promise<void> {
    try {
        await client.getIndex(indexUid);
        Logger.verbose(`Index "${indexUid}" already exists`, loggerCtx);
    } catch (e: any) {
        Logger.verbose(`Index "${indexUid}" does not exist. Creating...`, loggerCtx);
        const task = await client.createIndex(indexUid, { primaryKey });
        await client.tasks.waitForTask(task.taskUid);
        Logger.verbose(`Created index "${indexUid}"`, loggerCtx);
    }
}

/**
 * Configures a Meilisearch index with filterable, searchable, sortable, displayed attributes,
 * and optional relevancy settings (synonyms, stop words, ranking rules, typo tolerance).
 */
export async function configureIndex(
    client: MeiliSearch,
    indexUid: string,
    options?: MeilisearchRuntimeOptions,
): Promise<void> {
    const index = client.index(indexUid);

    const filterableAttributes = [
        'channelId',
        'languageCode',
        'facetValueIds',
        'collectionIds',
        'collectionSlugs',
        'enabled',
        'productEnabled',
        'productId',
        'sku',
        'inStock',
        'productInStock',
        'price',
        'priceWithTax',
        'productPriceMin',
        'productPriceMax',
        'productPriceWithTaxMin',
        'productPriceWithTaxMax',
        'productFacetIds',
        'productFacetValueIds',
        'productCollectionIds',
        'productCollectionSlugs',
        'productChannelIds',
        'channelIds',
    ];

    const searchableAttributes = [
        'productName',
        'productVariantName',
        'description',
        'sku',
        'slug',
    ];

    const sortableAttributes = [
        'productName',
        'price',
        'priceWithTax',
        'productPriceMin',
        'productPriceMax',
    ];

    const displayedAttributes = ['*'];

    Logger.verbose(`Configuring index "${indexUid}"...`, loggerCtx);

    const filterTask = await index.updateFilterableAttributes(filterableAttributes);
    await client.tasks.waitForTask(filterTask.taskUid);

    const searchTask = await index.updateSearchableAttributes(searchableAttributes);
    await client.tasks.waitForTask(searchTask.taskUid);

    const sortTask = await index.updateSortableAttributes(sortableAttributes);
    await client.tasks.waitForTask(sortTask.taskUid);

    const displayTask = await index.updateDisplayedAttributes(displayedAttributes);
    await client.tasks.waitForTask(displayTask.taskUid);

    // ── Optional relevancy settings ──

    await applyOptionalSetting(client, indexUid, 'synonyms',
        options?.synonyms && Object.keys(options.synonyms).length > 0
            ? expandSynonymsBidirectional(options.synonyms)
            : undefined,
        value => index.updateSynonyms(value),
    );
    await applyOptionalSetting(client, indexUid, 'stop words',
        options?.stopWords?.length ? options.stopWords : undefined,
        value => index.updateStopWords(value),
    );
    await applyOptionalSetting(client, indexUid, 'ranking rules',
        options?.rankingRules?.length ? options.rankingRules : undefined,
        value => index.updateRankingRules(value),
    );

    if (options?.typoTolerance) {
        Logger.verbose(`Configuring typo tolerance on "${indexUid}"...`, loggerCtx);
        const typoSettings: any = {};
        if (options.typoTolerance.enabled !== undefined) {
            typoSettings.enabled = options.typoTolerance.enabled;
        }
        if (options.typoTolerance.minWordSizeForOneTypo || options.typoTolerance.minWordSizeForTwoTypos) {
            typoSettings.minWordSizeForTypos = {};
            if (options.typoTolerance.minWordSizeForOneTypo) {
                typoSettings.minWordSizeForTypos.oneTypo = options.typoTolerance.minWordSizeForOneTypo;
            }
            if (options.typoTolerance.minWordSizeForTwoTypos) {
                typoSettings.minWordSizeForTypos.twoTypos = options.typoTolerance.minWordSizeForTwoTypos;
            }
        }
        if (options.typoTolerance.disableOnWords) {
            typoSettings.disableOnWords = options.typoTolerance.disableOnWords;
        }
        if (options.typoTolerance.disableOnAttributes) {
            typoSettings.disableOnAttributes = options.typoTolerance.disableOnAttributes;
        }
        const typoTask = await index.updateTypoTolerance(typoSettings);
        await client.tasks.waitForTask(typoTask.taskUid);
    }

    Logger.verbose(`Index "${indexUid}" configured successfully`, loggerCtx);
}

/**
 * Applies an optional index setting if the value is defined.
 * Logs the operation and waits for the Meilisearch task to complete.
 */
async function applyOptionalSetting(
    client: MeiliSearch,
    indexUid: string,
    name: string,
    value: any,
    updaterFn: (value: any) => Promise<{ taskUid: number }>,
): Promise<void> {
    if (value === undefined || value === null) {
        return;
    }
    Logger.verbose(`Setting ${name} on "${indexUid}"...`, loggerCtx);
    const task = await updaterFn(value);
    await client.tasks.waitForTask(task.taskUid);
}
