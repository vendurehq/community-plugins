import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
    Job as GraphQLJob,
    Permission,
    QuerySearchArgs,
    SearchResponse,
} from '@vendure/common/lib/generated-types';
import { Omit } from '@vendure/common/lib/omit';
import {
    Allow,
    Collection,
    Ctx,
    FacetValue,
    RequestContext,
    SearchJobBufferService,
    SearchResolver,
} from '@vendure/core';

import { MeilisearchService } from '../meilisearch.service';
import { MeilisearchSearchInput, SearchPriceData, SimilarDocumentsInput } from '../types';

@Resolver('SearchResponse')
export class ShopMeilisearchResolver implements Pick<SearchResolver, 'search'> {
    constructor(private meilisearchService: MeilisearchService) {}

    @Query()
    @Allow(Permission.Public)
    async search(
        @Ctx() ctx: RequestContext,
        @Args() args: QuerySearchArgs,
    ): Promise<Omit<SearchResponse, 'facetValues' | 'collections'>> {
        const result = await this.meilisearchService.search(ctx, args.input, true);
        // ensure the facetValues property resolver has access to the input args
        (result as any).input = args.input;
        return result;
    }

    @ResolveField()
    async prices(
        @Ctx() ctx: RequestContext,
        @Parent() parent: { input: MeilisearchSearchInput },
    ): Promise<SearchPriceData> {
        return this.meilisearchService.priceRange(ctx, parent.input);
    }
}

@Resolver('SearchResponse')
export class AdminMeilisearchResolver implements Pick<SearchResolver, 'search' | 'reindex'> {
    constructor(
        private meilisearchService: MeilisearchService,
        private searchJobBufferService: SearchJobBufferService,
    ) {}

    @Query()
    @Allow(Permission.ReadCatalog, Permission.ReadProduct)
    async search(
        @Ctx() ctx: RequestContext,
        @Args() args: QuerySearchArgs,
    ): Promise<Omit<SearchResponse, 'facetValues' | 'collections'>> {
        const result = await this.meilisearchService.search(ctx, args.input, false);
        // ensure the facetValues property resolver has access to the input args
        (result as any).input = args.input;
        return result;
    }

    @Mutation()
    @Allow(Permission.UpdateCatalog, Permission.UpdateProduct)
    async reindex(@Ctx() ctx: RequestContext): Promise<GraphQLJob> {
        return this.meilisearchService.reindex(ctx) as unknown as GraphQLJob;
    }

    @Query()
    @Allow(Permission.ReadCatalog, Permission.ReadProduct)
    async pendingSearchIndexUpdates(): Promise<any> {
        return this.searchJobBufferService.getPendingSearchUpdates();
    }

    @Mutation()
    @Allow(Permission.UpdateCatalog, Permission.UpdateProduct)
    async runPendingSearchIndexUpdates(): Promise<any> {
        // Intentionally not awaiting this method call
        void this.searchJobBufferService.runPendingSearchUpdates();
        return { success: true };
    }
}

@Resolver('SearchResponse')
export class EntityMeilisearchResolver implements Pick<SearchResolver, 'facetValues' | 'collections'> {
    constructor(private meilisearchService: MeilisearchService) {}

    @ResolveField()
    async facetValues(
        @Ctx() ctx: RequestContext,
        @Parent() parent: Omit<SearchResponse, 'facetValues' | 'collections'>,
    ): Promise<Array<{ facetValue: FacetValue; count: number }>> {
        const facetValues = await this.meilisearchService.facetValues(ctx, (parent as any).input, true);
        return facetValues.filter((i: { facetValue: FacetValue; count: number }) => !i.facetValue.facet.isPrivate);
    }

    @ResolveField()
    async collections(
        @Ctx() ctx: RequestContext,
        @Parent() parent: Omit<SearchResponse, 'facetValues' | 'collections'>,
    ): Promise<Array<{ collection: Collection; count: number }>> {
        const collections = await this.meilisearchService.collections(ctx, (parent as any).input, true);
        return collections.filter((i: { collection: Collection; count: number }) => !i.collection.isPrivate);
    }
}

/**
 * Resolver for the `similarDocuments` query. Only registered when AI search is enabled.
 */
@Resolver()
export class SimilarDocumentsResolver {
    constructor(private meilisearchService: MeilisearchService) {}

    @Query()
    @Allow(Permission.Public)
    async similarDocuments(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: SimilarDocumentsInput },
    ): Promise<{ items: any[]; totalItems: number }> {
        return this.meilisearchService.similarDocuments(ctx, args.input);
    }
}
