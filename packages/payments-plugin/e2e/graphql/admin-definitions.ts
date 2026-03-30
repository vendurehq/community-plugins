import { paymentMethodFragment, refundFragment } from './fragments-admin';
import { graphql } from './graphql-admin';

export const createPaymentMethodDocument = graphql(
    `
        mutation CreatePaymentMethod($input: CreatePaymentMethodInput!) {
            createPaymentMethod(input: $input) {
                ...PaymentMethod
            }
        }
    `,
    [paymentMethodFragment],
);

export const getCustomerListDocument = graphql(`
    query GetCustomerList($options: CustomerListOptions) {
        customers(options: $options) {
            items {
                id
                title
                firstName
                lastName
                emailAddress
                phoneNumber
                user {
                    id
                    verified
                }
            }
            totalItems
        }
    }
`);

export const getOrderPaymentsDocument = graphql(`
    query order($id: ID!) {
        order(id: $id) {
            id
            state
            totalWithTax
            payments {
                id
                transactionId
                method
                amount
                state
                errorMessage
                metadata
            }
        }
    }
`);

export const refundOrderDocument = graphql(
    `
        mutation RefundOrder($input: RefundOrderInput!) {
            refundOrder(input: $input) {
                ...Refund
                ... on ErrorResult {
                    errorCode
                    message
                }
            }
        }
    `,
    [refundFragment],
);

export const createChannelDocument = graphql(`
    mutation CreateChannel($input: CreateChannelInput!) {
        createChannel(input: $input) {
            ... on Channel {
                id
                code
                token
                currencyCode
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`);

export const testCreateStockLocationDocument = graphql(`
    mutation TestCreateStockLocation($input: CreateStockLocationInput!) {
        createStockLocation(input: $input) {
            id
            name
            description
        }
    }
`);

export const settlePaymentDocument = graphql(`
    mutation SettlePayment($id: ID!) {
        settlePayment(id: $id) {
            ... on Payment {
                id
                transactionId
                amount
                method
                state
                metadata
            }
            ... on ErrorResult {
                errorCode
                message
            }
            ... on SettlePaymentError {
                paymentErrorMessage
            }
        }
    }
`);

export const updateProductVariantsDocument = graphql(`
    mutation UpdateProductVariants($input: [UpdateProductVariantInput!]!) {
        updateProductVariants(input: $input) {
            id
            name
            sku
            price
            priceWithTax
            stockOnHand
        }
    }
`);

export const createProductDocument = graphql(`
    mutation CreateProduct($input: CreateProductInput!) {
        createProduct(input: $input) {
            id
            name
            slug
        }
    }
`);

export const createProductVariantsDocument = graphql(`
    mutation CreateProductVariants($input: [CreateProductVariantInput!]!) {
        createProductVariants(input: $input) {
            id
            name
            sku
            price
            priceWithTax
            stockOnHand
        }
    }
`);

export const createCouponDocument = graphql(`
    mutation CreatePromotion($input: CreatePromotionInput!) {
        createPromotion(input: $input) {
            ... on ErrorResult {
                errorCode
            }
            __typename
        }
    }
`);
