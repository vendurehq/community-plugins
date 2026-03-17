import { Inject, Injectable } from '@nestjs/common';
import {
    ActiveOrderService,
    idsAreEqual,
    isGraphQlErrorResult,
    Logger,
    Order,
    OrderLine,
    OrderService,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';
import fetch from 'node-fetch';

import {
    loggerCtx,
    PUNCHOUT_GATEWAY_PLUGIN_OPTIONS,
    SHIPPING_ORDERNUMBER,
    TRANSFERRED_ORDER_STATE,
} from '../constants';
import {
    PunchCommerceBasket,
    PunchCommercePosition,
    PunchCommerceProduct,
    PunchOutGatewayPluginOptions,
} from '../types';

export interface TransferCartResult {
    success: boolean;
    message?: string;
}

@Injectable()
export class PunchOutGatewayService {
    private readonly apiUrl: string;

    constructor(
        @Inject(PUNCHOUT_GATEWAY_PLUGIN_OPTIONS) private options: PunchOutGatewayPluginOptions,
        private activeOrderService: ActiveOrderService,
        private orderService: OrderService,
        private connection: TransactionalConnection,
    ) {
        this.apiUrl = options.apiUrl ?? 'https://www.punchcommerce.de';
    }

    async validateSession(sID: string, uID: string): Promise<boolean> {
        const url = `${this.apiUrl}/gateway/v3/session/validate?sID=${encodeURIComponent(sID)}&uID=${encodeURIComponent(uID)}`;
        Logger.debug(`Validating PunchOut session sID=${sID.substring(0, 8)}...`, loggerCtx);
        try {
            const response = await fetch(url, { method: 'GET' });
            return response.ok;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`Session validation request failed: ${message}`, loggerCtx);
            return false;
        }
    }

    async transferCart(ctx: RequestContext, sID: string): Promise<TransferCartResult> {
        const orderWithRelations = await this.connection.getRepository(ctx, Order)
            .createQueryBuilder('order')
            .leftJoinAndSelect('order.lines', 'lines')
            .leftJoinAndSelect('lines.productVariant', 'variant')
            .leftJoinAndSelect('variant.translations', 'variantTranslations')
            .leftJoinAndSelect('variant.product', 'product')
            .leftJoinAndSelect('product.translations', 'productTranslations')
            .leftJoinAndSelect('product.featuredAsset', 'featuredAsset')
            .leftJoinAndSelect('order.shippingLines', 'shippingLines')
            .leftJoinAndSelect('shippingLines.shippingMethod', 'shippingMethod')
            .leftJoinAndSelect('shippingMethod.translations', 'shippingMethodTranslations')
            .leftJoinAndSelect('order.customer', 'customer')
            .leftJoinAndSelect('customer.user', 'user')
            .leftJoin('order.channels', 'channel')
            .where('order.customFields.punchOutSessionId = :sID', { sID })
            .andWhere('order.active = :active', { active: true })
            .andWhere('channel.id = :channelId', { channelId: ctx.channelId })
            .getOne();

        if (!orderWithRelations) {
            return { success: false, message: 'No active order found for this PunchOut session' };
        }
        if (!ctx.activeUserId || !idsAreEqual(orderWithRelations.customer?.user?.id, ctx.activeUserId)) {
            return { success: false, message: 'Order does not belong to the authenticated user' };
        }

        const basket = this.transformOrderToBasket(ctx, orderWithRelations);
        const url = `${this.apiUrl}/gateway/v3/return?sID=${encodeURIComponent(sID)}`;
        Logger.verbose(`Transferring cart for order ${orderWithRelations.code} to PunchCommerce`, loggerCtx);
        Logger.debug(`Basket payload: ${JSON.stringify(basket, null, 2)}`, loggerCtx);

        try {
            const params = new URLSearchParams();
            params.append('basket', JSON.stringify(basket));
            const response = await fetch(url, {
                method: 'POST',
                body: params,
            });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                Logger.error(`Cart transfer response body: ${body}`, loggerCtx);
                Logger.error(
                    `Cart transfer failed: HTTP ${response.status} ${response.statusText}`,
                    loggerCtx,
                );
                return { success: false, message: `HTTP ${response.status}` };
            }
            Logger.verbose(`Cart transfer successful for order ${orderWithRelations.code}`, loggerCtx);
            const transitionResult = await this.orderService.transitionToState(
                ctx, orderWithRelations.id, TRANSFERRED_ORDER_STATE,
            );
            if (isGraphQlErrorResult(transitionResult)) {
                Logger.error(
                    `Cart transferred but order state transition failed: ${transitionResult.message}`,
                    loggerCtx,
                );
                return { success: true, message: 'Cart transferred but order could not be finalized' };
            }
            return { success: true };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`Cart transfer request failed: ${message}`, loggerCtx);
            return { success: false, message: `Request failed: ${message}` };
        }
    }

    // Assumes Vendure's default integer-cents money strategy
    private centsToDecimal(cents: number): number {
        return cents / 100;
    }

    private getTranslation<T extends { languageCode: string }>(
        translations: T[] | undefined,
        languageCode: string,
    ): T | undefined {
        return translations?.find(t => t.languageCode === languageCode) ?? translations?.[0];
    }

    private transformOrderToBasket(ctx: RequestContext, order: Order): PunchCommerceBasket {
        const positions: PunchCommercePosition[] = order.lines.map(line =>
            this.transformOrderLine(ctx, line),
        );

        const shippingCostMode = this.options.shippingCostMode ?? 'nonZero';
        if (shippingCostMode !== 'none') {
            const shippingWithTax = order.shippingWithTax;
            const shipping = order.shipping;
            if (shippingCostMode === 'all' || shippingWithTax > 0) {
                const shippingTaxRate = order.shippingLines[0]?.taxRate ?? 0;
                const shippingMethod = order.shippingLines[0]?.shippingMethod;
                const shippingName =
                    this.getTranslation(shippingMethod?.translations, ctx.languageCode)?.name ?? 'Shipping';
                positions.push({
                    product_ordernumber: SHIPPING_ORDERNUMBER,
                    product_name: shippingName,
                    quantity: 1,
                    item_price: this.centsToDecimal(shippingWithTax),
                    price: this.centsToDecimal(shippingWithTax),
                    price_net: this.centsToDecimal(shipping),
                    tax_rate: shippingTaxRate,
                    type: 'shipping-costs',
                    product: this.buildShippingProduct(shippingName, shipping, shippingTaxRate, ctx.channel.defaultCurrencyCode),
                });
            }
        }

        return { basket: positions };
    }

    private transformOrderLine(ctx: RequestContext, line: OrderLine): PunchCommercePosition {
        const variant = line.productVariant;
        const languageCode = ctx.languageCode;
        const variantName = this.getTranslation(variant.translations, languageCode)?.name ?? '';
        const product = variant.product;
        const productTranslation = this.getTranslation(product?.translations, languageCode);
        const productDescription = this.stripHtml(productTranslation?.description ?? '');
        // description = plain text for OCI protocol (max ~39 chars), description_long = full HTML
        const descriptionLong = productTranslation?.description ?? '';
        const sku = variant.sku;
        const currency = ctx.channel.defaultCurrencyCode;
        const imageUrl = product?.featuredAsset?.preview ?? '';

        return {
            product_ordernumber: sku,
            product_name: variantName,
            quantity: line.quantity,
            item_price: this.centsToDecimal(line.unitPriceWithTax),
            price: this.centsToDecimal(line.linePriceWithTax),
            price_net: this.centsToDecimal(line.linePrice),
            tax_rate: line.taxRate,
            type: 'product',
            product: {
                id: String(variant.id),
                ordernumber: sku,
                brand: '',
                brand_ordernumber: '',
                title: variantName,
                category: '',
                description: productDescription,
                description_long: descriptionLong,
                image_url: imageUrl,
                price: this.centsToDecimal(line.unitPrice),
                currency,
                tax_rate: line.taxRate,
                // PunchCommerce requires these fields even when not applicable
                purchase_unit: 1,
                reference_unit: 1,
                unit: 'PCE',
                unit_name: 'Piece',
                packaging_unit: 'Piece',
                weight: 0,
                shipping_time: 0,
                active: true,
            },
        };
    }

    private buildShippingProduct(name: string, netAmount: number, taxRate: number, currency: string): PunchCommerceProduct {
        return {
            id: SHIPPING_ORDERNUMBER,
            ordernumber: SHIPPING_ORDERNUMBER,
            brand: '',
            brand_ordernumber: '',
            title: name,
            category: '',
            description: name,
            description_long: '',
            image_url: '',
            price: this.centsToDecimal(netAmount),
            currency,
            tax_rate: taxRate,
            purchase_unit: 1,
            reference_unit: 1,
            unit: '',
            unit_name: '',
            packaging_unit: '',
            weight: 0,
            shipping_time: 0,
            active: true,
        };
    }

    private stripHtml(html: string): string {
        return html.replace(/<[^>]*>/g, '').trim();
    }
}
