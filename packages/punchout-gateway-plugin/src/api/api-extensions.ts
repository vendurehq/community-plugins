import gql from 'graphql-tag';

export const shopApiExtensions = gql`
    type PunchOutTransferResult {
        success: Boolean!
        message: String
    }

    extend type Mutation {
        transferPunchOutCart(sID: String!): PunchOutTransferResult!
    }
`;
