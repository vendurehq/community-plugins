import { Inject } from '@nestjs/common';
import { ResolveField, Resolver } from '@nestjs/graphql';
import { DeepRequired } from '@vendure/common/lib/shared-types';

import { OPENSEARCH_OPTIONS } from '../constants';
import { OpenSearchOptions } from '../options';

/**
 * This resolver is only required if both customProductMappings and customProductVariantMappings are
 * defined, since this particular configuration will result in a union type for the
 * `SearchResult.customMappings` GraphQL field.
 */
@Resolver('CustomMappings')
export class CustomMappingsResolver {
    constructor(@Inject(OPENSEARCH_OPTIONS) private options: DeepRequired<OpenSearchOptions>) {}

    @ResolveField()
    __resolveType(value: any): string {
        const productPropertyNames = Object.keys(this.options.customProductMappings);
        return Object.keys(value).every(k => productPropertyNames.includes(k))
            ? 'CustomProductMappings'
            : 'CustomProductVariantMappings';
    }
}
