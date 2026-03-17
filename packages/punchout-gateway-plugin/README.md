# PunchOut Gateway Plugin

A Vendure plugin for integrating with [PunchCommerce](https://www.punchcommerce.de), a PunchOut gateway that connects your Vendure store with enterprise procurement systems (SAP Ariba, Coupa, etc.) via OCI/cXML protocols.

PunchCommerce handles all protocol translation — this plugin only speaks JSON over HTTPS.

## How It Works

1. **Buyer clicks PunchOut link** in their ERP → PunchCommerce redirects to your **storefront** with `sID` and `uID` query params
2. **Storefront authenticates the buyer** by calling Vendure's `authenticate` mutation with the `punchout` strategy
3. **Buyer shops normally** — all order mutations use `activeOrderInput` to scope the cart to the PunchOut session
4. **On checkout**, storefront calls `transferPunchOutCart(sID)` to send the cart back to PunchCommerce

## Installation

```bash
npm install @vendure-community/punchout-gateway-plugin
```

## Configuration

```ts
import { PunchOutGatewayPlugin } from '@vendure-community/punchout-gateway-plugin';

export const config: VendureConfig = {
    plugins: [
        PunchOutGatewayPlugin.init({
            // All options are optional — defaults work out of the box
        }),
    ],
};
```

### Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `apiUrl` | No | `https://www.punchcommerce.de` | Base URL of the PunchCommerce gateway. Override for staging or self-hosted instances. |
| `shippingCostMode` | No | `'nonZero'` | Controls shipping line item in the basket: `'all'` = always include, `'nonZero'` = only when > 0, `'none'` = never include. |

## Customer Setup

Customers are linked to PunchCommerce via a custom field on the Customer entity.

1. **In PunchCommerce**: create a customer and set the "Customer identification" (this becomes the `uID`)
2. **In Vendure admin**: open the customer, set the **"PunchOut Customer ID (uID)"** custom field to the same value

## PunchCommerce Configuration

In the PunchCommerce dashboard, configure your customer:

- **Entry address**: your storefront's PunchOut landing page URL (e.g. `https://my-store.com/punchout`)
- **Customer identification**: a unique identifier matching the Vendure customer's custom field

PunchCommerce will redirect buyers to your Entry address with `?sID={UUID}&uID={identifier}` appended.

## Storefront Requirements

Since Vendure is headless, your storefront must handle the PunchOut flow. Here's what needs to be implemented:

### 1. PunchOut Landing Page

Create a route (e.g. `/punchout`) that PunchCommerce redirects to. This page must:

1. Extract `sID` and `uID` from the query params
2. Store the `sID` for the duration of the session (e.g. in `sessionStorage`)
3. Call the `authenticate` mutation
4. Redirect to the shop homepage on success

```ts
// e.g. https://my-store.com/punchout?sID=abc-123&uID=test-customer
const params = new URLSearchParams(window.location.search);
const sID = params.get('sID');
const uID = params.get('uID');

// Store sID for the session — needed for all order operations
sessionStorage.setItem('punchoutSID', sID);

const { authenticate } = await graphqlClient.mutate({
    mutation: gql`
        mutation PunchOutLogin($sID: String!, $uID: String!) {
            authenticate(input: { punchout: { sID: $sID, uID: $uID } }) {
                ... on CurrentUser { id }
                ... on InvalidCredentialsError { message }
            }
        }
    `,
    variables: { sID, uID },
});
```

### 2. Session-Scoped Cart (activeOrderInput)

All order mutations must include `activeOrderInput: { punchout: { sID } }` to scope the cart to the PunchOut session. This enables parallel sessions for the same customer.

```ts
const sID = sessionStorage.getItem('punchoutSID');

await graphqlClient.mutate({
    mutation: gql`
        mutation AddItem($variantId: ID!, $qty: Int!, $activeOrderInput: ActiveOrderInput) {
            addItemToOrder(
                productVariantId: $variantId
                quantity: $qty
                activeOrderInput: $activeOrderInput
            ) {
                ... on Order { id totalWithTax }
                ... on ErrorResult { message }
            }
        }
    `,
    variables: {
        variantId: '42',
        qty: 1,
        activeOrderInput: { punchout: { sID } },
    },
});
```

Pass `activeOrderInput` on **all** order operations: `addItemToOrder`, `adjustOrderLine`, `removeOrderLine`, `setOrderShippingAddress`, `setOrderShippingMethod`, `eligibleShippingMethods`, etc.

### 3. Transfer Cart (replaces Checkout)

Replace the normal checkout flow with a "Transfer Cart" / "Back to Procurement" button that sends the cart to PunchCommerce:

```ts
const { transferPunchOutCart } = await graphqlClient.mutate({
    mutation: gql`
        mutation TransferCart($sID: String!) {
            transferPunchOutCart(sID: $sID) { success message }
        }
    `,
    variables: { sID: sessionStorage.getItem('punchoutSID') },
});

if (transferPunchOutCart.success) {
    // Cart transferred — show confirmation to the buyer
}
```

### 4. iFrame Support (if applicable)

If PunchCommerce is configured for iFrame PunchOut (embedding the shop inside the ERP), your storefront must:

- Set `SameSite=None; Secure` on all session cookies
- Remove the `X-Frame-Options` header during PunchOut sessions
- These are typically configured in your web server or storefront framework

## GraphQL API Reference

### Authentication (built-in mutation)

```graphql
mutation {
    authenticate(input: { punchout: { sID: "...", uID: "..." } }) {
        ... on CurrentUser { id }
        ... on InvalidCredentialsError { message }
    }
}
```

### Transfer Cart

```graphql
mutation {
    transferPunchOutCart(sID: "...") {
        success
        message
    }
}
```

Requires an authenticated PunchOut session.

## Cart Mapping

The plugin maps Vendure order lines to PunchCommerce basket positions:

- **Prices** use gross/net pattern: `price` = gross (with tax), `price_net` = net (without tax)
- **All monetary values** are converted from Vendure's integer cents to decimal (÷ 100)
- **Shipping** is included as a separate position with `type: 'shipping-costs'` (controlled by `shippingCostMode`)
- **Product descriptions**: `description` is plain text (HTML stripped), `description_long` preserves HTML
- **Basket** is sent as `multipart/form-data` to PunchCommerce's `/gateway/v3/return` endpoint

## Parallel Sessions

The plugin uses a custom `ActiveOrderStrategy` to scope orders by PunchOut session ID (`sID`). This means:

- Each PunchOut session gets its own empty cart
- The same customer can have multiple concurrent PunchOut sessions
- Carts are isolated — items added in one session don't appear in another
