export interface DocsPackageConfig {
    packageDir: string;
    /** The docs reference subdirectory. Derived from @docsCategory via normalizeForUrlPart. */
    docsDir: string;
    exclude?: RegExp[];
}

/**
 * Single source of truth for the package → docs directory mapping.
 */
export const docsPackages: DocsPackageConfig[] = [
    { packageDir: 'braintree-plugin', docsDir: 'braintree-plugin' },
    { packageDir: 'elasticsearch-plugin', docsDir: 'elasticsearch-plugin' },
    { packageDir: 'meilisearch-plugin', docsDir: 'meilisearch-plugin' },
    { packageDir: 'mollie-plugin', docsDir: 'mollie-plugin', exclude: [/generated-shop-types/] },
    { packageDir: 'pub-sub-plugin', docsDir: 'pub-sub-plugin' },
    { packageDir: 'punchout-gateway-plugin', docsDir: 'punch-out-gateway-plugin' },
    { packageDir: 'sentry-plugin', docsDir: 'sentry-plugin' },
    { packageDir: 'stellate-plugin', docsDir: 'stellate-plugin' },
    { packageDir: 'stripe-plugin', docsDir: 'stripe-plugin' },
];
