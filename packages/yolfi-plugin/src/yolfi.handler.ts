import { LanguageCode, PaymentMethodHandler } from '@vendure/core';
import { YolfiService } from './yolfi.service';

let service: YolfiService;
const unsupported = async (): Promise<never> => {
    throw new Error('Yolfi supports verified one-time checkout only; manual capture, cancellation and refunds are unsupported');
};

export const yolfiPaymentHandler = new PaymentMethodHandler({
    code: 'yolfi',
    description: [{ languageCode: LanguageCode.en, value: 'Yolfi hosted one-time checkout' }],
    args: {},
    init: injector => { service = injector.get(YolfiService); },
    createPayment: (ctx, order, amount, _args, metadata, method) =>
        service.createPayment(ctx, order, amount, metadata, method),
    settlePayment: unsupported,
    cancelPayment: unsupported,
    createRefund: unsupported,
});
