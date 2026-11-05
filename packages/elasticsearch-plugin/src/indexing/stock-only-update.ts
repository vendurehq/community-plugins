/**
 * The `UpdateProductVariantInput` fields that only affect a variant's stock level, and therefore
 * its `inStock` / `productInStock` booleans (and any stock-derived custom mapping), but no other
 * indexed field. `id` is included because it is always present and identifies the variant.
 */
const STOCK_ONLY_UPDATE_FIELDS = new Set<string>([
    'id',
    'stockOnHand',
    'stockLevels',
    'trackInventory',
    'outOfStockThreshold',
    'useGlobalOutOfStockThreshold',
]);

/**
 * Returns `true` when a `ProductVariantEvent` 'updated' input touches only stock-level fields, so
 * the only indexed values that can change are the built-in stock booleans (and, if configured, a
 * stock-derived custom mapping). In that case the same pre-enqueue stock guard used for
 * `StockMovementEvent` can decide whether an index update is needed. Anything else (a name, price,
 * facet, asset, enabled or custom-field change), a non-array input, or an empty input returns
 * `false`, so the caller enqueues as before.
 */
export function isStockOnlyVariantUpdate(input: unknown): boolean {
    if (!Array.isArray(input) || input.length === 0) {
        return false;
    }
    return input.every(
        entry =>
            entry != null &&
            typeof entry === 'object' &&
            Object.keys(entry).every(key => STOCK_ONLY_UPDATE_FIELDS.has(key)),
    );
}
