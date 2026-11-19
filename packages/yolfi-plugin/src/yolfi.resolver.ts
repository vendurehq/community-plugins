import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { ActiveOrderService, Allow, Ctx, Permission, RequestContext } from '@vendure/core';
import { YolfiService } from './yolfi.service';

@Resolver()
export class YolfiResolver {
    constructor(private yolfi: YolfiService, private activeOrders: ActiveOrderService) {}

    @Mutation()
    @Allow(Permission.Owner)
    async createYolfiCheckout(
        @Ctx() ctx: RequestContext,
        @Args('paymentMethodCode') paymentMethodCode: string,
        @Args('attemptId') attemptId: string,
    ): Promise<string> {
        if (!ctx.authorizedAsOwnerOnly) throw new Error('Yolfi checkout requires an owner session');
        const order = await this.activeOrders.getActiveOrder(ctx, undefined);
        if (!order) throw new Error('Yolfi checkout requires an active order');
        return this.yolfi.createCheckout(ctx, order, paymentMethodCode, attemptId);
    }
}
