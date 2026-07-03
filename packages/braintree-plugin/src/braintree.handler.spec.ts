import { Injector } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getGateway } from './braintree-common';
import { braintreePaymentMethodHandler } from './braintree.handler';
import { BRAINTREE_PLUGIN_OPTIONS } from './constants';

vi.mock('./braintree-common', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./braintree-common')>();
    return {
        ...actual,
        getGateway: vi.fn(),
    };
});

const saleMock = vi.fn();

function initHandler(pluginOptions: Record<string, any>) {
    const fakeService = { hydrate: vi.fn().mockResolvedValue(undefined) };
    const fakeModuleRef = {
        get: (token: any) => (token === BRAINTREE_PLUGIN_OPTIONS ? pluginOptions : fakeService),
    };
    void braintreePaymentMethodHandler.init(new Injector(fakeModuleRef as any));
}

function createPayment() {
    return braintreePaymentMethodHandler.createPayment(
        {} as any,
        { code: 'T_1', currencyCode: 'GBP' } as any,
        4828,
        [
            { name: 'merchantId', value: 'merchant' },
            { name: 'publicKey', value: 'public' },
            { name: 'privateKey', value: 'private' },
        ],
        { nonce: 'fake-nonce' },
        {} as any,
    );
}

describe('braintreePaymentMethodHandler', () => {
    beforeEach(() => {
        saleMock.mockReset();
        vi.mocked(getGateway).mockReturnValue({ transaction: { sale: saleMock } } as any);
        initHandler({ storeCustomersInBraintree: false });
    });

    it('returns Declined with object metadata when the gateway rejects without a transaction', async () => {
        // Validation-class rejections (invalid customer id, consumed nonce, 3DS
        // amount mismatch) carry no transaction object in the response.
        saleMock.mockResolvedValue({ success: false, message: 'Customer ID is invalid.' });

        const result = await createPayment();

        expect(result.state).toBe('Declined');
        expect(result.errorMessage).toBe('Customer ID is invalid.');
        // Payment.metadata is a non-nullable column: undefined here crashes the
        // payment insert and surfaces a raw DB error to the customer.
        expect(result.metadata).toEqual({});
    });

    it('returns Declined with extracted metadata when the gateway declines with a transaction', async () => {
        saleMock.mockResolvedValue({
            success: false,
            message: 'Processor Declined',
            transaction: { id: 'tx_declined', status: 'processor_declined' },
        });

        const result = await createPayment();

        expect(result.state).toBe('Declined');
        expect(result.transactionId).toBe('tx_declined');
        expect(result.metadata).toMatchObject({ status: 'processor_declined' });
    });

    it('returns Settled with extracted metadata on success', async () => {
        saleMock.mockResolvedValue({
            success: true,
            transaction: { id: 'tx_ok', status: 'submitted_for_settlement' },
        });

        const result = await createPayment();

        expect(result.state).toBe('Settled');
        expect(result.transactionId).toBe('tx_ok');
        expect(result.metadata).toMatchObject({ status: 'submitted_for_settlement' });
    });

    it('applies a custom extractMetadata function', async () => {
        initHandler({
            storeCustomersInBraintree: false,
            extractMetadata: (transaction: any) => ({ txStatus: transaction.status }),
        });
        saleMock.mockResolvedValue({
            success: true,
            transaction: { id: 'tx_ok', status: 'authorized' },
        });

        const result = await createPayment();

        expect(result.metadata).toEqual({ txStatus: 'authorized' });
    });
});
