export interface PunchOutGatewayPluginOptions {
    /**
     * Base URL of the PunchCommerce gateway API.
     * Override for staging or self-hosted instances.
     *
     * @default 'https://www.punchcommerce.de'
     */
    apiUrl?: string;
    /**
     * Controls how shipping costs are included in the basket sent
     * back to PunchCommerce.
     *
     * - `'all'` — always include shipping (even when €0.00)
     * - `'nonZero'` — only include when shipping > 0
     * - `'none'` — never include shipping as a line item
     *
     * @default 'nonZero'
     */
    shippingCostMode?: 'all' | 'nonZero' | 'none';
}

declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomCustomerFields {
        punchOutUid: string;
    }

    interface CustomOrderFields {
        punchOutSessionId: string;
    }
}

/** Matches the GraphQL `input PunchOutAuthInput` defined in `PunchOutAuthenticationStrategy.defineInputType()`. */
export interface PunchOutAuthInput {
    sID: string;
    uID: string;
}

/** Matches the GraphQL `input PunchOutActiveOrderInput` defined in `PunchOutActiveOrderStrategy.defineInputType()`. */
export interface PunchOutActiveOrderInput {
    sID: string;
}

// ── PunchCommerce request/response DTOs ────────────────────────────

export interface PunchCommerceProduct {
    id: string;
    ordernumber: string;
    brand: string;
    brand_ordernumber: string;
    title: string;
    category: string;
    description: string;
    description_long: string;
    image_url: string;
    price: number;
    currency: string;
    tax_rate: number;
    purchase_unit: number;
    reference_unit: number;
    unit: string;
    unit_name: string;
    packaging_unit: string;
    weight: number;
    shipping_time: number;
    active: boolean;
}

export interface PunchCommercePosition {
    product_ordernumber: string;
    product_name: string;
    quantity: number;
    item_price: number;
    price: number;
    price_net: number;
    tax_rate: number;
    type: 'product' | 'shipping-costs';
    product: PunchCommerceProduct;
}

export interface PunchCommerceBasket {
    basket: PunchCommercePosition[];
}
