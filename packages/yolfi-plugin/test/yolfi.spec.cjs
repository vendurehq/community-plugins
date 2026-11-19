// Focused adapter tests. HTTP, decorators and Vendure services are mocked collaborators.
// No application, database or network is started.
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require(process.argv[2] || 'typescript');
const root = path.resolve(__dirname, '..');
const cache = new Map();
const noopDecorator = () => () => {};
const core = {
    LanguageCode: { en: 'en' }, PluginCommonModule: class {}, Permission: { Owner: 'Owner' },
    PaymentMethodHandler: class { constructor(options) { Object.assign(this, options); } },
    VendurePlugin: options => target => { target.definition = options; },
    Allow: noopDecorator, Ctx: noopDecorator,
};
for (const name of ['Order', 'Payment', 'ConfigService', 'PaymentMethodService', 'OrderService',
    'TransactionalConnection', 'RequestContextService', 'ActiveOrderService']) core[name] = class {};
const nest = { Injectable: noopDecorator, Inject: noopDecorator, Controller: noopDecorator,
    Post: noopDecorator, Req: noopDecorator, Headers: noopDecorator,
    BadRequestException: class extends Error {}, UnauthorizedException: class extends Error {} };
function load(relative) {
    const filename = path.resolve(root, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const source = fs.readFileSync(filename, 'utf8');
    const compiled = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
            experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true } });
    const errors = compiled.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error);
    assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n',
    }));
    const module = new Module(filename); cache.set(filename, module);
    module.filename = filename;
    module.require = id => {
        if (id === '@vendure/core') return core;
        if (id === '@nestjs/common') return nest;
        if (id === '@nestjs/graphql') return { Resolver: noopDecorator, Mutation: noopDecorator, Args: noopDecorator };
        if (id === 'graphql-tag') return { gql: strings => strings.join('') };
        if (id === 'body-parser') return { raw: options => { const handler = () => {}; handler.options = options; return handler; } };
        if (id.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), id + '.ts')));
        return require(id);
    };
    module._compile(compiled.outputText, filename);
    return module.exports;
}
const client = load('src/yolfi-client.ts');
const { YolfiService } = load('src/yolfi.service.ts');
const { yolfiPaymentHandler } = load('src/yolfi.handler.ts');
const { YolfiPlugin } = load('src/yolfi.plugin.ts');
const { YolfiResolver } = load('src/yolfi.resolver.ts');
const { YolfiController } = load('src/yolfi.controller.ts');
const options = { apiKey: 'EXAMPLE_API_KEY', webhookSecret: 'EXAMPLE_WEBHOOK_SECRET',
    successUrl: 'https://shop.example.com/thanks', cancelUrl: 'https://shop.example.com/cart', livemode: false };
const ctx = { apiType: 'admin', channelId: 'test-channel-id', channel: { token: 'test-channel' } };
const order = () => ({ id: 'test-order-id', code: 'TEST-ORDER', state: 'ArrangingPayment',
    totalWithTax: 2499, currencyCode: 'USD', payments: [] });
const method = { id: 'test-method-id', code: 'yolfi-test', handler: { code: 'yolfi' } };
let httpCalls = [];
let httpQueue = [];
// Explicitly mocked transport. Every request must consume a synthetic fixture.
global.fetch = async (url, init) => {
    httpCalls.push({ url, init });
    assert.equal(httpQueue.length > 0, true, 'unexpected HTTP request');
    const next = httpQueue.shift();
    if (next instanceof Error) throw next;
    return { ok: next.ok !== false, status: next.status || 200, json: async () => next.body,
        text: async () => JSON.stringify(next.body) };
};
const ok = data => ({ body: { success: true, data } });
function snapshot(o = order()) {
    return { id: 'ycs_test_session', object: 'checkout_session', status: 'OPEN', amount: '24.99',
        currency: 'USD', merchantOrderId: client.merchantReference(ctx, o, method),
        url: 'https://pay.yolfi.com/ycs_test_session' };
}
function event(o = order()) {
    return { id: 'evt_test_confirmation', type: 'payment.confirmed', livemode: false,
        data: { invoiceId: '00000000-0000-4000-8000-000000000001', checkoutSessionId: 'ycs_test_session',
            merchantOrderId: client.merchantReference(ctx, o, method), currency: 'USD',
            paymentType: 'ONE_TIME', status: 'confirmed', amount: '0.00123', amountUsd: '3.45',
            metadata: { orderId: o.id, channelToken: ctx.channel.token, paymentMethodCode: method.code } } };
}
function signed(e = event()) {
    const raw = Buffer.from(JSON.stringify(e));
    return { raw, signature: createHmac('sha256', options.webhookSecret).update(raw).digest('base64') };
}
function harness(o = order()) {
    const calls = []; let recorded = []; let lockTail = Promise.resolve();
    const orders = {
        findOne: async () => { calls.push('findOrder'); return { ...o }; },
        getOrderPayments: async () => recorded,
        getEligiblePaymentMethods: async () => [{ id: method.id, code: method.code, isEligible: true }],
        addPaymentToOrder: async (c, id, input) => {
            calls.push('addPayment');
            const result = await service.createPayment(c, { ...o, payments: recorded }, o.totalWithTax, input.metadata, method);
            recorded.push({ ...result, method: method.code });
            return { ...o, state: 'PaymentSettled' };
        },
    };
    const methods = { getMethodAndOperations: async () => ({ paymentMethod: method, handler: { code: 'yolfi' } }) };
    const connection = {
        rawConnection: { options: { type: 'postgres' } },
        withTransaction: async (c, fn) => {
            // Mock the transactional DB's serialization, not payment logic.
            let unlock; const previous = lockTail;
            lockTail = new Promise(resolve => { unlock = resolve; }); await previous;
            try { return await fn(c); } finally { unlock(); }
        },
        getRepository: () => ({ findOne: async query => {
            assert.deepEqual(query.lock, { mode: 'pessimistic_write' });
            assert.equal(query.where.id, o.id); calls.push('lock'); return o;
        } }),
    };
    const contexts = { create: async input => { calls.push('context'); assert.equal(input.channelOrToken, ctx.channel.token); return ctx; } };
    const config = { entityOptions: { moneyStrategy: { precision: 2 } } };
    const service = new YolfiService(options, config, methods, orders, connection, contexts);
    return { service, orders, methods, config, connection, calls, get recorded() { return recorded; } };
}
test.beforeEach(() => { httpCalls = []; httpQueue = []; });
test('formats configured Vendure precision without float rounding or ISO assumptions', () => {
    assert.equal(client.price(2499, 2), '24.99'); assert.equal(client.price(12345, 3), '12.345');
    assert.equal(client.price(99, 0), '99'); assert.equal(client.price(100, 2), '1.00');
    for (const n of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => client.price(n, 2));
    assert.throws(() => client.price(1, 3));
    for (const p of [-1, 1.1, 10]) assert.throws(() => client.price(100, p));
    assert.equal(client.samePrice('24.990000', '24.99'), true);
    for (const value of ['24.98', '2.499e1', '-24.99', 'NaN', '24.9901', 24.99]) assert.equal(client.samePrice(value, '24.99'), false);
});
test('HMAC verifies exact raw bytes and rejects malformed, missing and tampered signatures', () => {
    const s = signed(); assert.equal(client.parseWebhook(s.raw, s.signature, options).id, event().id);
    for (const signature of ['', 'bad', s.signature + 'x', 'A'.repeat(44)]) assert.throws(() => client.parseWebhook(s.raw, signature, options));
    assert.throws(() => client.parseWebhook(Buffer.concat([s.raw, Buffer.from(' ')]), s.signature, options));
    assert.throws(() => client.parseWebhook(s.raw, s.signature, { ...options, webhookSecret: 'EXAMPLE_WRONG_SECRET' }));
    assert.throws(() => client.parseWebhook(s.raw, s.signature, { ...options, livemode: true }));
});
test('creates native checkout, stable retry key, immutable total and no buyer data', async () => {
    const h = harness(); httpQueue.push(ok(snapshot()), ok(snapshot()));
    assert.equal(await h.service.createCheckout(ctx, order(), method.code), snapshot().url);
    await h.service.createCheckout(ctx, order(), method.code);
    const first = httpCalls[0]; assert.equal(first.url, 'https://app.yolfi.com/api/checkout-sessions');
    assert.equal(first.init.method, 'POST'); assert.equal(first.init.redirect, 'error');
    assert.equal(first.init.headers.Authorization, 'Bearer EXAMPLE_API_KEY');
    assert.equal(first.init.headers['Idempotency-Key'], httpCalls[1].init.headers['Idempotency-Key']);
    assert.match(first.init.headers['Idempotency-Key'], /^[a-z0-9_-]{16,200}$/);
    const payload = JSON.parse(first.init.body);
    assert.deepEqual(payload, { amount: '24.99', currency: 'USD', merchantOrderId: snapshot().merchantOrderId,
        successUrl: options.successUrl, cancelUrl: options.cancelUrl,
        metadata: { orderId: order().id, channelToken: ctx.channel.token, paymentMethodCode: method.code, attemptId: 'initial-checkout-attempt' } });
    assert.ok(first.init.signal instanceof AbortSignal);
});
test('new order price yields a distinct request key; configured non-default precision is used', async () => {
    const h = harness(); httpQueue.push(ok(snapshot())); await h.service.createCheckout(ctx, order(), method.code);
    h.config.entityOptions.moneyStrategy.precision = 3;
    httpQueue.push(ok({ ...snapshot(), amount: '2.499' })); await h.service.createCheckout(ctx, order(), method.code);
    assert.notEqual(httpCalls[0].init.headers['Idempotency-Key'], httpCalls[1].init.headers['Idempotency-Key']);
    assert.equal(JSON.parse(httpCalls[1].init.body).amount, '2.499');
});
test('rejects ineligible, partial, unsupported-currency and non-checkout orders before HTTP', async () => {
    const h = harness();
    for (const o of [{ ...order(), currencyCode: 'GBP' }, { ...order(), state: 'Cancelled' },
        { ...order(), totalWithTax: 0 }, { ...order(), payments: [{ state: 'Settled' }] }]) {
        await assert.rejects(h.service.createCheckout(ctx, o, method.code));
    }
    h.orders.getEligiblePaymentMethods = async () => [];
    await assert.rejects(h.service.createCheckout(ctx, order(), method.code)); assert.equal(httpCalls.length, 0);
});
test('rejects HTTP, timeout, false-success and malformed checkout fixtures', async () => {
    const h = harness();
    const fixtures = [{ ok: false, status: 401 }, { ok: false, status: 409 }, { ok: false, status: 503 },
        new Error('synthetic timeout'), { body: { success: false, message: 'fixture' } }, ok({}),
        ok({ ...snapshot(), currency: 'EUR' }), ok({ ...snapshot(), amount: '25.00' }),
        ok({ ...snapshot(), merchantOrderId: 'wrong' }), ok({ ...snapshot(), url: 'https://evil.example.com/' })];
    for (const fixture of fixtures) { httpQueue.push(fixture); await assert.rejects(h.service.createCheckout(ctx, order(), method.code)); }
});
test('actual payment handler verifies signed session reference, not token amounts or redirects', async () => {
    const h = harness(); yolfiPaymentHandler.init({ get: () => h.service });
    const s = signed(); httpQueue.push(ok({ ...snapshot(), status: 'COMPLETED' }));
    const result = await yolfiPaymentHandler.createPayment(ctx, order(), 2499, {},
        { body: s.raw.toString(), signature: s.signature }, method);
    assert.equal(result.state, 'Settled'); assert.equal(result.amount, 2499);
    assert.equal(result.transactionId, event().data.invoiceId);
    assert.deepEqual(result.metadata, { checkoutSessionId: event().data.checkoutSessionId, eventId: event().id });
    await assert.rejects(yolfiPaymentHandler.createPayment({ ...ctx, apiType: 'shop' }, order(), 2499, {},
        { body: s.raw.toString(), signature: s.signature }, method));
    await assert.rejects(yolfiPaymentHandler.createPayment(ctx, order(), 2499, {}, { confirmed: true }, method));
});
test('rejects reference, currency, session, amount and invoice-state mismatches', async () => {
    for (const change of [{ amount: '24.98' }, { currency: 'EUR' }, { merchantOrderId: 'wrong' },
        { id: 'ycs_other' }, { status: 'OPEN' }]) {
        const h = harness(); const s = signed(); httpQueue.push(ok({ ...snapshot(), status: 'COMPLETED', ...change }));
        await assert.rejects(h.service.createPayment(ctx, order(), 2499, { body: s.raw.toString(), signature: s.signature }, method));
    }
    for (const change of [{ merchantOrderId: 'wrong' }, { currency: 'EUR' }, { status: 'pending' },
        { paymentType: 'RECURRING' }, { subscriptionId: 'test-subscription' }, { paylinkId: 'test-paylink' },
        { invoiceId: '' }, { checkoutSessionId: '' }]) {
        const h = harness(); const e = event(); Object.assign(e.data, change); const s = signed(e);
        await assert.rejects(h.service.createPayment(ctx, order(), 2499, { body: s.raw.toString(), signature: s.signature }, method));
    }
    const h = harness(); const s = signed();
    await assert.rejects(h.service.createPayment(ctx, order(), 2400, { body: s.raw.toString(), signature: s.signature }, method));
});
test('verified webhook records once, locks first, and survives duplicate and concurrent delivery', async () => {
    const h = harness(); const s = signed(); httpQueue.push(ok({ ...snapshot(), status: 'COMPLETED' }));
    await Promise.all([h.service.handleWebhook(s.raw, s.signature), h.service.handleWebhook(s.raw, s.signature)]);
    await h.service.handleWebhook(s.raw, s.signature);
    assert.equal(h.recorded.length, 1); assert.equal(h.calls.filter(c => c === 'addPayment').length, 1);
    assert.equal(h.calls.indexOf('lock') < h.calls.indexOf('findOrder'), true); assert.equal(httpCalls.length, 1);
});
test('invalid signatures cause no lookup; overdue, pending and unrelated events do not pay', async () => {
    const h = harness(); await assert.rejects(h.service.handleWebhook(signed().raw, 'bad')); assert.equal(h.calls.length, 0);
    for (const type of ['invoice.overdue', 'invoice.created', 'subscription.cancelled']) {
        const s = signed({ ...event(), type }); await h.service.handleWebhook(s.raw, s.signature);
    }
    assert.equal(h.recorded.length, 0); assert.equal(httpCalls.length, 0);
    const e = event(); e.data.status = 'pending'; const s = signed(e);
    await assert.rejects(h.service.handleWebhook(s.raw, s.signature)); assert.equal(h.recorded.length, 0);
});
test('framework errors and mismatched routing fail closed and permit retry', async () => {
    const h = harness(); const s = signed();
    const original = h.orders.addPaymentToOrder;
    h.orders.addPaymentToOrder = async () => ({ errorCode: 'TEST_ERROR', message: 'synthetic' });
    await assert.rejects(h.service.handleWebhook(s.raw, s.signature)); assert.equal(h.recorded.length, 0);
    h.orders.addPaymentToOrder = original;
    httpQueue.push(ok({ ...snapshot(), status: 'COMPLETED' }));
    await h.service.handleWebhook(s.raw, s.signature); assert.equal(h.recorded.length, 1);
    const e = event(); e.data.metadata.channelToken = 'another-channel'; const wrong = signed(e);
    await assert.rejects(h.service.createPayment(ctx, order(), 2499, { body: wrong.raw.toString(), signature: wrong.signature }, method));
    const late = harness({ ...order(), state: 'Cancelled' }); await assert.rejects(late.service.handleWebhook(s.raw, s.signature));
});
test('setup registers beside providers, raw parser runs early, unsupported operations reject', async () => {
    const existing = { code: 'existing' };
    YolfiPlugin.init(options);
    const cfg = { paymentOptions: { paymentMethodHandlers: [existing] }, apiOptions: { middleware: [] }, dbConnectionOptions: { type: 'postgres' } };
    YolfiPlugin.definition.configuration(cfg);
    assert.equal(cfg.paymentOptions.paymentMethodHandlers[0], existing);
    assert.equal(cfg.paymentOptions.paymentMethodHandlers[1], yolfiPaymentHandler);
    assert.equal(cfg.apiOptions.middleware[0].beforeListen, true);
    assert.equal(cfg.apiOptions.middleware[0].route, '/payments/yolfi');
    assert.equal(cfg.apiOptions.middleware[0].handler.options.type, 'application/json');
    assert.throws(() => YolfiPlugin.definition.configuration({ ...cfg, dbConnectionOptions: { type: 'sqlite' } }));
    for (const name of ['settlePayment', 'cancelPayment', 'createRefund']) await assert.rejects(async () => yolfiPaymentHandler[name]());
});
test('expired checkout can be retried with a new attempt while transport retries reuse one key', async () => {
    const h = harness();
    httpQueue.push(ok({ ...snapshot(), status: 'EXPIRED' }), ok(snapshot()), ok(snapshot()));
    await assert.rejects(h.service.createCheckout(ctx, order(), method.code, 'test-attempt-0001'));
    await h.service.createCheckout(ctx, order(), method.code, 'test-attempt-0002');
    await h.service.createCheckout(ctx, order(), method.code, 'test-attempt-0002');
    assert.notEqual(httpCalls[0].init.headers['Idempotency-Key'], httpCalls[1].init.headers['Idempotency-Key']);
    assert.equal(httpCalls[1].init.headers['Idempotency-Key'], httpCalls[2].init.headers['Idempotency-Key']);
    for (const id of ['', 'short', '../not-an-attempt', 'a'.repeat(101)]) {
        await assert.rejects(h.service.createCheckout(ctx, order(), method.code, id));
    }
});
test('shop resolver only uses owner active order and controller passes untouched raw Buffer', async () => {
    let observed;
    const service = { createCheckout: async (...args) => { observed = args; return snapshot().url; },
        handleWebhook: async (...args) => { observed = args; } };
    const active = { getActiveOrder: async () => order() };
    const resolver = new YolfiResolver(service, active);
    await resolver.createYolfiCheckout({ ...ctx, authorizedAsOwnerOnly: true }, method.code, 'test-attempt-0001');
    assert.equal(observed[1].id, order().id);
    assert.equal(observed[3], 'test-attempt-0001');
    await assert.rejects(resolver.createYolfiCheckout({ ...ctx, authorizedAsOwnerOnly: false }, method.code));
    active.getActiveOrder = async () => undefined;
    await assert.rejects(resolver.createYolfiCheckout({ ...ctx, authorizedAsOwnerOnly: true }, method.code));
    const controller = new YolfiController(service); const s = signed();
    await controller.webhook(s.signature, { body: s.raw }); assert.equal(observed[0], s.raw);
    await assert.rejects(controller.webhook(s.signature, { body: event() }));
});
