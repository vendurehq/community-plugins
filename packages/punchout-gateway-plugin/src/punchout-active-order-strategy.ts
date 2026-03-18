import {
    ActiveOrderStrategy,
    Injector,
    Order,
    OrderService,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';
import { DocumentNode } from 'graphql';
import gql from 'graphql-tag';

export interface PunchOutActiveOrderInput {
    sID: string;
}

/**
 * An ActiveOrderStrategy that scopes active orders by PunchOut session ID.
 *
 * This ensures each PunchOut session gets its own separate cart,
 * even when the same service user has multiple concurrent sessions.
 *
 * Storefronts pass the sID via `activeOrderInput: { punchout: { sID: "..." } }`
 * on all order-related Shop API operations (addItemToOrder, etc.).
 */
export class PunchOutActiveOrderStrategy implements ActiveOrderStrategy<PunchOutActiveOrderInput> {
    readonly name = 'punchout';

    private connection: TransactionalConnection;
    private orderService: OrderService;

    init(injector: Injector) {
        this.connection = injector.get(TransactionalConnection);
        this.orderService = injector.get(OrderService);
    }

    defineInputType(): DocumentNode {
        return gql`
            input PunchOutActiveOrderInput {
                sID: String!
            }
        `;
    }

    async determineActiveOrder(ctx: RequestContext, input: PunchOutActiveOrderInput): Promise<Order | undefined> {
        if (!input?.sID) {
            return undefined;
        }
        const qb = this.connection
            .getRepository(ctx, Order)
            .createQueryBuilder('order')
            .leftJoin('order.channels', 'channel')
            .leftJoin('order.customer', 'customer')
            .leftJoin('customer.user', 'user')
            .where('order.customFields.punchOutSessionId = :sID', { sID: input.sID })
            .andWhere('order.active = :active', { active: true })
            .andWhere('channel.id = :channelId', { channelId: ctx.channelId });

        if (ctx.activeUserId) {
            qb.andWhere('user.id = :userId', { userId: ctx.activeUserId });
        }
        const order = await qb.getOne();
        if (order) {
            return order;
        }
        // Create the order eagerly so that read-only queries (activeOrder)
        // never fall through to the DefaultActiveOrderStrategy, which would
        // return a stale order from a different PunchOut session.
        return this.createActiveOrder(ctx, input);
    }

    async createActiveOrder(ctx: RequestContext, input: PunchOutActiveOrderInput): Promise<Order> {
        const order = await this.orderService.create(ctx, ctx.activeUserId);
        await this.connection.getRepository(ctx, Order).update(order.id, {
            customFields: { punchOutSessionId: input.sID },
        });
        // Re-fetch to ensure customFields are populated on the returned entity
        return this.connection.getRepository(ctx, Order).findOneOrFail({ where: { id: order.id } });
    }
}
