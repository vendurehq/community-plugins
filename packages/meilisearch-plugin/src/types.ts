import {
    Coordinate,
    CurrencyCode,
    LanguageCode,
    PriceRange,
    SearchInput,
    SearchResponse,
    SearchResult,
} from '@vendure/common/lib/generated-types';
import { ID, JsonCompatible } from '@vendure/common/lib/shared-types';
import { Asset, SerializedRequestContext } from '@vendure/core';

export type MeilisearchSearchResult = SearchResult & {
    inStock: boolean;
};

export type MeilisearchSearchInput = SearchInput & {
    priceRange?: PriceRange;
    priceRangeWithTax?: PriceRange;
    inStock?: boolean;
    groupBySKU?: boolean;
    [extendedInputField: string]: any;
};

export type MeilisearchSearchResponse = SearchResponse & {
    priceRange: SearchPriceData;
    items: MeilisearchSearchResult[];
};

export type SearchPriceData = {
    range: PriceRange;
    rangeWithTax: PriceRange;
    buckets: PriceRangeBucket[];
    bucketsWithTax: PriceRangeBucket[];
};

export type PriceRangeBucket = {
    to: number;
    count: number;
};

export type MeilisearchSortInput = string[];

export type IndexItemAssets = {
    productAssetId: ID | undefined;
    productPreview: string;
    productPreviewFocalPoint: Coordinate | undefined;
    productVariantAssetId: ID | undefined;
    productVariantPreview: string;
    productVariantPreviewFocalPoint: Coordinate | undefined;
};

export type VariantIndexItem = Omit<
    SearchResult,
    'score' | 'price' | 'priceWithTax' | 'productAsset' | 'productVariantAsset'
> &
    IndexItemAssets & {
        id: string; // Meilisearch requires an `id` primary key
        channelId: ID;
        languageCode: LanguageCode;
        price: number;
        priceWithTax: number;
        collectionSlugs: string[];
        productEnabled: boolean;
        productPriceMin: number;
        productPriceMax: number;
        productPriceWithTaxMin: number;
        productPriceWithTaxMax: number;
        productFacetIds: ID[];
        productFacetValueIds: ID[];
        productCollectionIds: ID[];
        productCollectionSlugs: string[];
        productChannelIds: ID[];
        [customMapping: string]: any;
        inStock: boolean;
        productInStock: boolean;
    };

export type ProductIndexItem = IndexItemAssets & {
    id: string;
    sku: string;
    slug: string;
    productId: ID;
    channelId: ID;
    languageCode: LanguageCode;
    productName: string;
    productVariantId: ID;
    productVariantName: string;
    currencyCode: CurrencyCode;
    description: string;
    facetIds: ID[];
    facetValueIds: ID[];
    collectionIds: ID[];
    collectionSlugs: string[];
    channelIds: ID[];
    enabled: boolean;
    productEnabled: boolean;
    priceMin: number;
    priceMax: number;
    priceWithTaxMin: number;
    priceWithTaxMax: number;
    [customMapping: string]: any;
};

export interface ReindexMessageResponse {
    total: number;
    completed: number;
    duration: number;
}

export type ReindexMessageData = {
    ctx: SerializedRequestContext;
};

export type UpdateProductMessageData = {
    ctx: SerializedRequestContext;
    productId: ID;
};

export type UpdateVariantMessageData = {
    ctx: SerializedRequestContext;
    variantIds: ID[];
};

export interface UpdateVariantsByIdMessageData {
    ctx: SerializedRequestContext;
    ids: ID[];
}

export interface ProductChannelMessageData {
    ctx: SerializedRequestContext;
    productId: ID;
    channelId: ID;
}

export type VariantChannelMessageData = {
    ctx: SerializedRequestContext;
    productVariantId: ID;
    channelId: ID;
};

export interface UpdateAssetMessageData {
    ctx: SerializedRequestContext;
    asset: JsonCompatible<Required<Asset>>;
}

type Maybe<T> = T | undefined;
type NamedJobData<Type extends string, MessageData> = { type: Type } & MessageData;

export type ReindexJobData = NamedJobData<'reindex', ReindexMessageData>;
type UpdateProductJobData = NamedJobData<'update-product', UpdateProductMessageData>;
type UpdateVariantsJobData = NamedJobData<'update-variants', UpdateVariantMessageData>;
type DeleteProductJobData = NamedJobData<'delete-product', UpdateProductMessageData>;
type DeleteVariantJobData = NamedJobData<'delete-variant', UpdateVariantMessageData>;
type UpdateVariantsByIdJobData = NamedJobData<'update-variants-by-id', UpdateVariantsByIdMessageData>;
type UpdateAssetJobData = NamedJobData<'update-asset', UpdateAssetMessageData>;
type DeleteAssetJobData = NamedJobData<'delete-asset', UpdateAssetMessageData>;
type AssignProductToChannelJobData = NamedJobData<'assign-product-to-channel', ProductChannelMessageData>;
type RemoveProductFromChannelJobData = NamedJobData<'remove-product-from-channel', ProductChannelMessageData>;
type AssignVariantToChannelJobData = NamedJobData<'assign-variant-to-channel', VariantChannelMessageData>;
type RemoveVariantFromChannelJobData = NamedJobData<'remove-variant-from-channel', VariantChannelMessageData>;
export type UpdateIndexQueueJobData =
    | ReindexJobData
    | UpdateProductJobData
    | UpdateVariantsJobData
    | DeleteProductJobData
    | DeleteVariantJobData
    | UpdateVariantsByIdJobData
    | UpdateAssetJobData
    | DeleteAssetJobData
    | AssignProductToChannelJobData
    | RemoveProductFromChannelJobData
    | AssignVariantToChannelJobData
    | RemoveVariantFromChannelJobData;

export type GraphQlPrimitive = 'ID' | 'String' | 'Int' | 'Float' | 'Boolean';
export type PrimitiveTypeVariations<T extends GraphQlPrimitive> = T | `${T}!` | `[${T}!]` | `[${T}!]!`;
type GraphQlPermittedReturnType = PrimitiveTypeVariations<GraphQlPrimitive>;

type CustomMappingDefinition<Args extends any[], T extends GraphQlPermittedReturnType, R> = {
    graphQlType: T;
    public?: boolean;
    valueFn: (...args: Args) => Promise<R> | R;
};

type TypeVariationMap<GqlType extends GraphQlPrimitive, TsType> = {
    [Key in PrimitiveTypeVariations<GqlType>]: Key extends `[${string}!]!`
        ? TsType[]
        : Key extends `[${string}!]`
        ? Maybe<TsType[]>
        : Key extends `${string}!`
        ? TsType
        : Maybe<TsType>;
};

type GraphQlTypeMap = TypeVariationMap<'ID', ID> &
    TypeVariationMap<'String', string> &
    TypeVariationMap<'Int', number> &
    TypeVariationMap<'Float', number> &
    TypeVariationMap<'Boolean', boolean>;

export type CustomMapping<Args extends any[]> = {
    [Type in GraphQlPermittedReturnType]: CustomMappingDefinition<Args, Type, GraphQlTypeMap[Type]>;
}[GraphQlPermittedReturnType];
