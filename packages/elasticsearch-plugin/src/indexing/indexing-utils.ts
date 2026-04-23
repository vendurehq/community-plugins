import { DeepRequired, ID, Logger } from '@vendure/core';

import type { SearchClientAdapter } from '../adapter';
import { loggerCtx, VARIANT_INDEX_NAME } from '../constants';
import { ElasticsearchOptions } from '../options';
import { VariantIndexItem } from '../types';

export async function createIndices(
    adapter: SearchClientAdapter,
    prefix: string,
    indexSettings: object,
    indexMappingProperties: object,
    mapAlias = true,
    aliasPostfix = '',
) {
    const textWithKeyword = {
        type: 'text',
        fields: {
            keyword: {
                type: 'keyword',
                ignore_above: 256,
            },
        },
    };
    const keyword = { type: 'keyword' };

    const variantMappings: { [prop in keyof VariantIndexItem]: any } = {
        sku: textWithKeyword,
        slug: textWithKeyword,
        productId: keyword,
        channelId: keyword,
        languageCode: keyword,
        productName: textWithKeyword,
        productVariantId: keyword,
        productVariantName: textWithKeyword,
        currencyCode: keyword,
        description: textWithKeyword,
        facetIds: keyword,
        facetValueIds: keyword,
        collectionIds: keyword,
        collectionSlugs: keyword,
        channelIds: keyword,
        enabled: { type: 'boolean' },
        productEnabled: { type: 'boolean' },
        productAssetId: keyword,
        productPreview: textWithKeyword,
        productPreviewFocalPoint: { type: 'object' },
        productVariantAssetId: keyword,
        productVariantPreview: textWithKeyword,
        productVariantPreviewFocalPoint: { type: 'object' },
        productChannelIds: keyword,
        productCollectionIds: keyword,
        productCollectionSlugs: keyword,
        productFacetIds: keyword,
        productFacetValueIds: keyword,
        productPriceMax: { type: 'long' },
        productPriceMin: { type: 'long' },
        productPriceWithTaxMax: { type: 'long' },
        productPriceWithTaxMin: { type: 'long' },
        price: { type: 'long' },
        priceWithTax: { type: 'long' },
        inStock: { type: 'boolean' },
        productInStock: { type: 'boolean' },
        ...indexMappingProperties,
    };

    const unixtimestampPostfix = new Date().getTime();

    const createIndex = async (mappings: { [prop in keyof any]: any }, index: string, alias: string) => {
        if (mapAlias) {
            await adapter.indices.create({
                index,
                body: {
                    mappings: {
                        properties: mappings,
                    },
                    settings: indexSettings,
                },
            });
            await adapter.indices.putAlias({
                index,
                name: alias,
            });
            Logger.verbose(`Created index "${index}"`, loggerCtx);
        } else {
            await adapter.indices.create({
                index: alias,
                body: {
                    mappings: {
                        properties: mappings,
                    },
                    settings: indexSettings,
                },
            });
        }
    };

    try {
        const index = prefix + VARIANT_INDEX_NAME + `${unixtimestampPostfix}`;
        const alias = prefix + VARIANT_INDEX_NAME + aliasPostfix;

        await createIndex(variantMappings, index, alias);
    } catch (e: any) {
        Logger.error(JSON.stringify(e, null, 2), loggerCtx);
    }
}

export async function deleteIndices(adapter: SearchClientAdapter, prefix: string) {
    try {
        const index = await getIndexNameByAlias(adapter, prefix + VARIANT_INDEX_NAME);
        if (index) {
            await adapter.indices.delete({ index });
            Logger.verbose(`Deleted index "${index}"`, loggerCtx);
        }
    } catch (e: any) {
        Logger.error(e, loggerCtx);
    }
}

export async function deleteByChannel(adapter: SearchClientAdapter, prefix: string, channelId: ID) {
    try {
        const index = prefix + VARIANT_INDEX_NAME;
        await adapter.deleteByQuery({
            index,
            body: {
                query: {
                    match: { channelId },
                },
            },
        });
        Logger.verbose(`Deleted index "${index} for channel "${channelId}"`, loggerCtx);
    } catch (e: any) {
        Logger.error(e, loggerCtx);
    }
}

export async function getIndexNameByAlias(adapter: SearchClientAdapter, aliasName: string) {
    const aliasExist = await adapter.indices.existsAlias({ name: aliasName });
    if (aliasExist.body) {
        const alias = await adapter.indices.getAlias({
            name: aliasName,
        });
        const keys = Object.keys(alias.body);
        return keys[0];
    } else {
        return aliasName;
    }
}
