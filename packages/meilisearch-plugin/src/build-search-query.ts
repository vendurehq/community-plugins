import { LogicalOperator, SortOrder } from '@vendure/common/lib/generated-types';
import { ID, RequestContext } from '@vendure/core';
import { UserInputError } from '@vendure/core';

import { MeilisearchRuntimeOptions } from './options';
import { MeilisearchSearchInput } from './types';

/**
 * Escapes special characters in a value before interpolating it into
 * a Meilisearch filter string. Prevents filter injection via user-supplied
 * values like collection slugs or facet value IDs.
 */
export function escapeFilterValue(value: string | number): string {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Builds a Meilisearch filter string from the search input and request context.
 * Extracted as a pure function for testability.
 */
export function buildFilter(
    ctx: RequestContext,
    input: MeilisearchSearchInput,
    enabledOnly: boolean,
): string {
    const filterParts: string[] = [];
    const esc = (v: string | number) => escapeFilterValue(v);

    filterParts.push(`channelId = "${esc(ctx.channelId)}"`);
    filterParts.push(`languageCode = "${esc(ctx.languageCode)}"`);

    if (enabledOnly) {
        filterParts.push('enabled = true');
    }

    const {
        facetValueIds,
        facetValueOperator,
        facetValueFilters,
        collectionId,
        collectionSlug,
        groupByProduct,
        priceRange,
        priceRangeWithTax,
        inStock,
    } = input;

    if (facetValueIds && facetValueIds.length) {
        if (facetValueOperator === LogicalOperator.AND) {
            for (const id of facetValueIds) {
                filterParts.push(`facetValueIds = "${esc(id)}"`);
            }
        } else {
            const orParts = facetValueIds.map(id => `facetValueIds = "${esc(id)}"`);
            filterParts.push(`(${orParts.join(' OR ')})`);
        }
    }

    if (facetValueFilters && facetValueFilters.length) {
        for (const facetValueFilter of facetValueFilters) {
            if (facetValueFilter.and && facetValueFilter.or && facetValueFilter.or.length) {
                throw new UserInputError('error.facetfilterinput-invalid-input');
            }
            if (facetValueFilter.and) {
                filterParts.push(`facetValueIds = "${esc(facetValueFilter.and)}"`);
            }
            if (facetValueFilter.or && facetValueFilter.or.length) {
                const orParts = facetValueFilter.or.map(id => `facetValueIds = "${esc(id)}"`);
                filterParts.push(`(${orParts.join(' OR ')})`);
            }
        }
    }

    if (collectionId) {
        filterParts.push(`collectionIds = "${esc(collectionId)}"`);
    }
    const collectionIds = input.collectionIds as string[] | undefined;
    if (collectionIds && collectionIds.length) {
        const uniqueIds = Array.from(new Set(collectionIds));
        const orParts = uniqueIds.map(id => `collectionIds = "${esc(id)}"`);
        filterParts.push(`(${orParts.join(' OR ')})`);
    }
    if (collectionSlug) {
        filterParts.push(`collectionSlugs = "${esc(collectionSlug)}"`);
    }
    const collectionSlugs: string[] | undefined = input.collectionSlugs;
    if (collectionSlugs && collectionSlugs.length) {
        const uniqueSlugs = Array.from(new Set(collectionSlugs));
        const orParts = uniqueSlugs.map(slug => `collectionSlugs = "${esc(slug)}"`);
        filterParts.push(`(${orParts.join(' OR ')})`);
    }

    if (priceRange) {
        filterParts.push(`price >= ${Number(priceRange.min)}`);
        filterParts.push(`price <= ${Number(priceRange.max)}`);
    }
    if (priceRangeWithTax) {
        filterParts.push(`priceWithTax >= ${Number(priceRangeWithTax.min)}`);
        filterParts.push(`priceWithTax <= ${Number(priceRangeWithTax.max)}`);
    }

    if (inStock !== undefined) {
        if (groupByProduct) {
            filterParts.push(`productInStock = ${inStock}`);
        } else {
            filterParts.push(`inStock = ${inStock}`);
        }
    }

    return filterParts.join(' AND ');
}

/**
 * Builds a Meilisearch sort array from the search input.
 * Extracted as a pure function for testability.
 */
export function buildSort(
    input: MeilisearchSearchInput,
    options: MeilisearchRuntimeOptions,
): string[] {
    const sortArray: string[] = [];
    if (input.sort) {
        if (input.sort.name) {
            sortArray.push(`productName:${input.sort.name === SortOrder.ASC ? 'asc' : 'desc'}`);
        }
        if (input.sort.price) {
            sortArray.push(`price:${input.sort.price === SortOrder.ASC ? 'asc' : 'desc'}`);
        }
    }
    return options.searchConfig.mapSort
        ? options.searchConfig.mapSort(sortArray, input)
        : sortArray;
}
