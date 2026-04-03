import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';

import { PunchOutGatewayService } from '../service/punchout-gateway.service';

@Resolver()
export class PunchOutGatewayResolver {
    constructor(private punchOutGatewayService: PunchOutGatewayService) {}

    @Mutation()
    @Allow(Permission.Owner)
    async transferPunchOutCart(
        @Ctx() ctx: RequestContext,
        @Args() args: { sID: string },
    ) {
        return this.punchOutGatewayService.transferCart(ctx, args.sID);
    }
}
