import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Order, PaymentMethod, RequestContext } from '@vendure/core';

export interface YolfiOptions {
    apiKey: string;
    webhookSecret: string;
    successUrl: string;
    cancelUrl: string;
    /** Explicitly use false only for a sandbox endpoint. Defaults to true. */
    livemode?: boolean;
}
export interface CheckoutSession {
    id: string;
    object: string;
    status: string;
    amount: string;
    currency: string;
    merchantOrderId: string;
    url: string;
}
export interface YolfiEvent {
    id: string;
    type: string;
    livemode: boolean;
    data: {
        invoiceId: string;
        checkoutSessionId: string;
        merchantOrderId: string;
        currency: string;
        paymentType: string;
        status: string;
        paylinkId?: string;
        subscriptionId?: string;
        metadata: { orderId: string; channelToken: string; paymentMethodCode: string };
    };
}
const currencies = new Set(['USD', 'EUR', 'CNY', 'RUB', 'INR', 'TRY', 'KRW', 'JPY']);
export function assertCurrency(currency: string): void {
    if (!currencies.has(currency)) throw new Error('Unsupported Yolfi pricing currency');
}
/** Vendure MoneyStrategy precision, not token decimals or inferred currency exponents. */
export function price(value: number, precision: number): string {
    if (!Number.isSafeInteger(value) || value <= 0 || !Number.isInteger(precision) || precision < 0 || precision > 9) {
        throw new Error('Invalid Yolfi order amount or precision');
    }
    if (BigInt(value) * 100n < 10n ** BigInt(precision)) throw new Error('Yolfi minimum is 0.01');
    if (precision === 0) return String(value);
    const digits = String(value).padStart(precision + 1, '0');
    return `${digits.slice(0, -precision)}.${digits.slice(-precision)}`;
}
export function samePrice(actual: unknown, expected: string): boolean {
    const normalize = (value: unknown): string | undefined => {
        if (typeof value !== 'string' || value.length > 100 || !/^\d+(\.\d+)?$/.test(value)) return;
        const [whole, fractional = ''] = value.split('.');
        return `${BigInt(whole)}.${fractional.replace(/0+$/, '')}`;
    };
    return normalize(actual) !== undefined && normalize(actual) === normalize(expected);
}
export function merchantReference(ctx: RequestContext, order: Order, method: PaymentMethod): string {
    return 'vnd_' + createHash('sha256').update(JSON.stringify([
        String(ctx.channelId), String(order.id), order.code, String(method.id), method.code,
    ])).digest('hex');
}
export function idempotencyKey(payload: object): string {
    return 'vendure_' + createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
export function parseWebhook(raw: Buffer, signature: string | undefined, options: YolfiOptions): YolfiEvent {
    if (!Buffer.isBuffer(raw) || raw.length > 65536 || !options.webhookSecret ||
        typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) {
        throw new Error('Invalid Yolfi webhook signature');
    }
    const expected = createHmac('sha256', options.webhookSecret).update(raw).digest();
    const actual = Buffer.from(signature, 'base64');
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) {
        throw new Error('Invalid Yolfi webhook signature');
    }
    let event: YolfiEvent;
    try { event = JSON.parse(raw.toString('utf8')) as YolfiEvent; } catch {
        throw new Error('Invalid Yolfi webhook JSON');
    }
    if (!event || typeof event.id !== 'string' || !/^evt_[a-zA-Z0-9_-]{1,196}$/.test(event.id) ||
        typeof event.type !== 'string' || event.livemode !== (options.livemode ?? true)) {
        throw new Error('Invalid Yolfi webhook envelope or mode');
    }
    return event;
}
export function assertConfirmation(event: YolfiEvent): void {
    const d = event.data;
    const bounded = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 255;
    if (event.type !== 'payment.confirmed' || !d || d.status !== 'confirmed' || d.paymentType !== 'ONE_TIME' ||
        d.paylinkId || d.subscriptionId || !bounded(d.invoiceId) ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(d.invoiceId) ||
        typeof d.checkoutSessionId !== 'string' || !/^ycs_[a-zA-Z0-9_-]{1,196}$/.test(d.checkoutSessionId) ||
        !bounded(d.merchantOrderId) || !bounded(d.currency) || !d.metadata ||
        !bounded(d.metadata.orderId) || !bounded(d.metadata.channelToken) || !bounded(d.metadata.paymentMethodCode)) {
        throw new Error('Invalid Yolfi one-time confirmation');
    }
}
/** No configurable host, redirects, response-body logging or credential fallbacks. */
export async function requestSession(options: YolfiOptions, path: string, payload?: object): Promise<CheckoutSession> {
    if (!options.apiKey) throw new Error('Yolfi API key is required');
    let response: Response;
    let body: { success?: boolean; data?: CheckoutSession };
    try {
        response = await fetch('https://app.yolfi.com/api/checkout-sessions' + path, {
            method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { Authorization: options.apiKey ? `Bearer ${options.apiKey}` : '', 'Content-Type': 'application/json',
                ...(payload ? { 'Idempotency-Key': idempotencyKey(payload) } : {}) },
            ...(payload ? { body: JSON.stringify(payload) } : {}),
        });
        if (!response.ok) throw new Error('Non-success response');
        const text = await response.text();
        if (text.length > 65536) throw new Error('Oversized response');
        body = JSON.parse(text);
    } catch {
        throw new Error('Yolfi API request failed; retry the same checkout request');
    }
    const s = body?.data;
    if (body?.success !== true || !s || typeof s.id !== 'string' || !/^ycs_[a-zA-Z0-9_-]{1,196}$/.test(s.id) ||
        s.object !== 'checkout_session' || !['OPEN', 'PROCESSING', 'COMPLETED', 'EXPIRED'].includes(s.status)) {
        throw new Error('Invalid Yolfi checkout response');
    }
    return s;
}
export function hostedUrl(session: CheckoutSession): string {
    let url: URL;
    try { url = new URL(session.url); } catch { throw new Error('Invalid Yolfi hosted URL'); }
    if (url.protocol !== 'https:' || url.hostname !== 'pay.yolfi.com' || url.port || url.username || url.password ||
        url.pathname !== '/' + session.id) throw new Error('Invalid Yolfi hosted URL');
    return session.url;
}
