import {
    AuthenticationStrategy,
    Customer,
    Injector,
    Logger,
    RequestContext,
    TransactionalConnection,
    User,
} from '@vendure/core';
import { DocumentNode } from 'graphql';
import gql from 'graphql-tag';

import { loggerCtx, PUNCHOUT_STRATEGY_NAME } from './constants';
import { PunchOutGatewayService } from './service/punchout-gateway.service';
import { PunchOutAuthInput } from './types';

export class PunchOutAuthenticationStrategy implements AuthenticationStrategy<PunchOutAuthInput> {
    readonly name = PUNCHOUT_STRATEGY_NAME;

    private punchOutService: PunchOutGatewayService;
    private connection: TransactionalConnection;

    defineInputType(): DocumentNode {
        return gql`
            input PunchOutAuthInput {
                sID: String!
                uID: String!
            }
        `;
    }

    init(injector: Injector) {
        this.punchOutService = injector.get(PunchOutGatewayService);
        this.connection = injector.get(TransactionalConnection);
    }

    async authenticate(ctx: RequestContext, data: PunchOutAuthInput): Promise<User | false | string> {
        const { sID, uID } = data;
        const valid = await this.punchOutService.validateSession(sID, uID);
        if (!valid) {
            Logger.warn(
                `PunchOut session validation failed for sID=${sID.substring(0, 8)}...`,
                loggerCtx,
            );
            return 'PunchOut session validation failed';
        }

        const customer = await this.connection
            .getRepository(ctx, Customer)
            .createQueryBuilder('customer')
            .leftJoinAndSelect('customer.user', 'user')
            .where('customer.customFields.punchOutUid = :uID', { uID })
            .andWhere('customer.deletedAt IS NULL')
            .getOne();

        if (!customer?.user) {
            Logger.warn(
                `No customer found with punchOutUid '${uID}'`,
                loggerCtx,
            );
            return 'Invalid PunchOut credentials';
        }

        Logger.verbose(`PunchOut authentication successful`, loggerCtx);
        return customer.user;
    }
}
