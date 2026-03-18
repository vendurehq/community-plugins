import gql from 'graphql-tag';

export const AUTHENTICATE_PUNCHOUT = gql`
    mutation AuthenticatePunchOut($sID: String!, $uID: String!) {
        authenticate(input: { punchout: { sID: $sID, uID: $uID } }) {
            __typename
            ... on CurrentUser {
                id
                identifier
            }
            ... on InvalidCredentialsError {
                errorCode
                message
            }
        }
    }
`;

export const TRANSFER_PUNCHOUT_CART = gql`
    mutation TransferPunchOutCart($sID: String!) {
        transferPunchOutCart(sID: $sID) {
            success
            message
        }
    }
`;

export const ADD_ITEM_TO_ORDER = gql`
    mutation AddItemToOrder($productVariantId: ID!, $quantity: Int!, $activeOrderInput: ActiveOrderInput) {
        addItemToOrder(productVariantId: $productVariantId, quantity: $quantity, activeOrderInput: $activeOrderInput) {
            ... on Order {
                id
                code
                totalWithTax
                lines {
                    id
                    quantity
                    unitPriceWithTax
                    linePriceWithTax
                    productVariant {
                        id
                        sku
                        name
                    }
                }
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

export const SET_SHIPPING_ADDRESS = gql`
    mutation SetShippingAddress($input: CreateAddressInput!, $activeOrderInput: ActiveOrderInput) {
        setOrderShippingAddress(input: $input, activeOrderInput: $activeOrderInput) {
            ... on Order {
                id
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

export const GET_ELIGIBLE_SHIPPING_METHODS = gql`
    query GetShippingMethods($activeOrderInput: ActiveOrderInput) {
        eligibleShippingMethods(activeOrderInput: $activeOrderInput) {
            id
            code
            price
            name
        }
    }
`;

export const SET_SHIPPING_METHOD = gql`
    mutation SetShippingMethod($id: [ID!]!, $activeOrderInput: ActiveOrderInput) {
        setOrderShippingMethod(shippingMethodId: $id, activeOrderInput: $activeOrderInput) {
            ... on Order {
                id
                shipping
                shippingWithTax
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

export const GET_ACTIVE_ORDER = gql`
    query GetActiveOrder($activeOrderInput: ActiveOrderInput) {
        activeOrder(activeOrderInput: $activeOrderInput) {
            id
            code
            totalQuantity
            lines {
                id
                quantity
                productVariant {
                    sku
                }
            }
        }
    }
`;
