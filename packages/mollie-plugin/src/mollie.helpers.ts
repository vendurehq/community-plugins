import { CreateParameters } from '@mollie/api-client/dist/types/binders/payments/parameters';
import { Amount, Address as MollieAddress } from '@mollie/api-client/dist/types/data/global';
import { PaymentLine, PaymentLineType } from '@mollie/api-client/dist/types/data/payments/data';
import { ConfigService, Customer, Order } from '@vendure/core';
import currency from 'currency.js';

import { OrderAddress } from './graphql/generated-shop-types';

/**
 * Check if given address has mandatory fields for Mollie and map to a MollieAddress.
 * Returns undefined if address doesn't have all mandatory fields
 */
export function toMollieAddress(address: OrderAddress, customer: Customer): MollieAddress | undefined {
    if (address.city && address.countryCode && address.streetLine1 && address.postalCode) {
        return {
            streetAndNumber: `${address.streetLine1} ${address.streetLine2 || ''}`,
            postalCode: address.postalCode,
            city: address.city,
            country: address.countryCode.toUpperCase(),
            givenName: customer.firstName,
            familyName: customer.lastName,
            email: customer.emailAddress,
        };
    }
}

/**
 * Map all order and shipping lines to a single array of Mollie payment lines.
 * The money values of the order are in the precision of the store, see `getMoneyPrecision()`.
 */
export function toMolliePaymentLines(
    order: Order,
    alreadyPaid: number,
    precision = 2,
): CreateParameters['lines'] {
    // Add lines
    const lines: PaymentLine[] = order.lines.map(line => ({
        description: line.productVariant.name,
        quantity: line.quantity,
        unitPrice: toAmount(line.proratedLinePriceWithTax / line.quantity, order.currencyCode, precision), // totalAmount has to match unitPrice * quantity
        totalAmount: toAmount(line.proratedLinePriceWithTax, order.currencyCode, precision),
        vatRate: line.taxRate.toFixed(2),
        vatAmount: toAmount(
            calculateLineTaxAmount(line.taxRate, line.proratedLinePriceWithTax),
            order.currencyCode,
            precision,
        ),
    }));
    // Add shippingLines
    lines.push(
        ...order.shippingLines.map(line => ({
            description: line.shippingMethod?.name || 'Shipping',
            quantity: 1,
            unitPrice: toAmount(line.discountedPriceWithTax, order.currencyCode, precision),
            totalAmount: toAmount(line.discountedPriceWithTax, order.currencyCode, precision),
            vatRate: String(line.taxRate),
            vatAmount: toAmount(
                line.discountedPriceWithTax - line.discountedPrice,
                order.currencyCode,
                precision,
            ),
        })),
    );
    // Add surcharges
    lines.push(
        ...order.surcharges.map(surcharge => ({
            description: surcharge.description,
            quantity: 1,
            unitPrice: toAmount(surcharge.priceWithTax, order.currencyCode, precision),
            totalAmount: toAmount(surcharge.priceWithTax, order.currencyCode, precision),
            vatRate: String(surcharge.taxRate),
            vatAmount: toAmount(surcharge.priceWithTax - surcharge.price, order.currencyCode, precision),
            type: surcharge.priceWithTax < 0 ? ('store_credit' as PaymentLineType) : undefined,
        })),
    );
    // Deduct amount already paid
    if (alreadyPaid) {
        lines.push({
            description: 'Already paid',
            quantity: 1,
            unitPrice: toAmount(-alreadyPaid, order.currencyCode, precision),
            totalAmount: toAmount(-alreadyPaid, order.currencyCode, precision),
            vatRate: String(0),
            vatAmount: toAmount(0, order.currencyCode, precision),
            type: 'store_credit' as PaymentLineType, // Needed to allow negative unitPrice
        });
    }
    return lines;
}

/**
 * Stringify and fixed decimals. The value is in the precision of the store's `MoneyStrategy`: with the
 * default precision of 2 it is in cents, with a precision of 3 in thousandths. Mollie always gets 2 decimals,
 * so anything smaller than a cent is rounded.
 */
export function toAmount(value: number, orderCurrency: string, precision = 2): Amount {
    return {
        value: (value / 10 ** precision).toFixed(2),
        currency: orderCurrency,
    };
}

/**
 * Return the amount in the precision of the store's `MoneyStrategy`, rounded to a whole number.
 * E.g. '10.00' => 1000 with the default precision of 2, and 10000 with a precision of 3.
 */
export function amountToCents(amount: Amount, precision = 2): number {
    const cents = currency(amount.value).intValue;
    // With the default precision of 2 the cents are returned as they are
    return precision >= 2 ? cents * 10 ** (precision - 2) : Math.round(cents / 10 ** (2 - precision));
}

/**
 * The precision of the store's `MoneyStrategy`: the number of decimals that a money value of Vendure stands for.
 * It is optional and defaults to 2, and 0 is a valid precision.
 */
export function getMoneyPrecision(configService: ConfigService): number {
    return configService.entityOptions.moneyStrategy.precision ?? 2;
}

/**
 * Recalculate tax amount per order line instead of per unit for Mollie.
 * Vendure calculates tax per unit, but Mollie expects the tax to be calculated per order line (the total of the quantities).
 * See https://github.com/vendurehq/vendure/issues/1939#issuecomment-1362962133 for more information on the rounding issue.
 */
export function calculateLineTaxAmount(taxRate: number, orderLinePriceWithTax: number): number {
    const taxMultiplier = taxRate / 100;
    return orderLinePriceWithTax * (taxMultiplier / (1 + taxMultiplier)); // I.E. €99,99 * (0,2 ÷ 1,2) with a 20% taxrate
}
