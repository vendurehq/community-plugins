import { LanguageCode } from '@vendure/common/lib/generated-types';
import * as core from '@vendure/core';
import { ChannelService, mergeConfig, PaymentMethod, RequestContext, TransactionalConnection } from '@vendure/core';
import { preBootstrapConfig } from '@vendure/core/dist/bootstrap';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN } from '@vendure/testing';
import path from 'path';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { StripePlugin, StripePluginOptions } from '../src';
import { stripePaymentMethodHandler } from '../src/stripe.handler';
import { StripeService } from '../src/stripe.service';

import { createPaymentMethodDocument } from './graphql/admin-definitions';
import { graphql } from './graphql/graphql-admin';

const API_KEY = 'sk_test_api_key';
const WEBHOOK_SECRET = 'whsec_test_signing_secret';
const CIPHERTEXT_PREFIX = 'enc:v1:';
// The value of REDACTED_SECRET_PLACEHOLDER, which only exists in Vendure 3.8 and later.
const REDACTED_PLACEHOLDER = '__vendure_secret_unchanged_v1__';

// The repo builds against the lowest supported Vendure version, where encryption does not exist, so
// these are looked up at runtime. Run this file against Vendure 3.8 or later to exercise them.
const { DefaultEncryptionStrategy } = core as unknown as {
    DefaultEncryptionStrategy?: new (options: { secret: string }) => unknown;
};
const supportsEncryption = DefaultEncryptionStrategy !== undefined;

const updatePaymentMethodDocument = graphql(`
    mutation UpdatePaymentMethodArgs($input: UpdatePaymentMethodInput!) {
        updatePaymentMethod(input: $input) {
            id
            handler {
                args {
                    name
                    value
                }
            }
        }
    }
`);

function handlerInput(apiKey: string, webhookSecret: string) {
    return {
        code: stripePaymentMethodHandler.code,
        arguments: [
            { name: 'apiKey', value: apiKey },
            { name: 'webhookSecret', value: webhookSecret },
        ],
    };
}

function startServer(systemOptions: object = {}) {
    return createTestEnvironment(mergeConfig(testConfig(), { plugins: [StripePlugin], systemOptions }));
}

async function setupPaymentMethod(
    env: ReturnType<typeof startServer>,
    options: StripePluginOptions,
): Promise<string> {
    // The options are static and describe bodies all run at collection time, so they can only be set
    // for one server by setting them right before it starts.
    StripePlugin.init(options);
    await env.server.init({
        initialData,
        productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
        customerCount: 1,
    });
    await env.adminClient.asSuperAdmin();
    const { createPaymentMethod } = await env.adminClient.query(createPaymentMethodDocument, {
        input: {
            code: `stripe-payment-${E2E_DEFAULT_CHANNEL_TOKEN}`,
            translations: [{ name: 'Stripe', description: '', languageCode: LanguageCode.en }],
            enabled: true,
            handler: handlerInput(API_KEY, WEBHOOK_SECRET),
        },
    });
    return createPaymentMethod.id;
}

/** Reads the args directly from the database, bypassing the API's decryption and redaction. */
async function getStoredArgs(env: ReturnType<typeof startServer>): Promise<Record<string, string>> {
    const repository = env.server.app.get(TransactionalConnection).rawConnection.getRepository(PaymentMethod);
    const [paymentMethod] = await repository.find();
    return Object.fromEntries(paymentMethod.handler.args.map(arg => [arg.name, arg.value]));
}

async function setStoredArgs(
    env: ReturnType<typeof startServer>,
    apiKey: string,
    webhookSecret: string,
): Promise<void> {
    const repository = env.server.app.get(TransactionalConnection).rawConnection.getRepository(PaymentMethod);
    const [paymentMethod] = await repository.find();
    paymentMethod.handler.args = [
        { name: 'apiKey', value: apiKey },
        { name: 'webhookSecret', value: webhookSecret },
    ];
    await repository.save(paymentMethod);
}

async function getClient(env: ReturnType<typeof startServer>) {
    const channel = await env.server.app.get(ChannelService).getDefaultChannel();
    const ctx = new RequestContext({
        apiType: 'admin',
        isAuthorized: true,
        authorizedAsOwnerOnly: false,
        channel,
    });
    return { client: await env.server.app.get(StripeService).getStripeClientForChannel(ctx), ctx };
}

/** Proves that the plaintext secret is what the webhook signature is verified against. */
async function expectWebhookVerifiesWith(env: ReturnType<typeof startServer>, secret: string) {
    const { ctx } = await getClient(env);
    const payload = JSON.stringify({ id: 'evt_test', object: 'event' });
    const signature = new Stripe('test').webhooks.generateTestHeaderString({ payload, secret });
    const event = await env.server.app
        .get(StripeService)
        .constructEventForChannel(ctx, Buffer.from(payload), signature);
    expect(event.id).toBe('evt_test');
}

describe.skipIf(supportsEncryption)('encryptSecrets on Vendure older than 3.8', () => {
    it('refuses to start rather than storing the credentials in plain text', async () => {
        const config = mergeConfig(testConfig(), {
            plugins: [StripePlugin.init({ encryptSecrets: true })],
        });
        await expect(preBootstrapConfig(config)).rejects.toThrow(
            'The StripePlugin `encryptSecrets` option requires Vendure 3.8.0 or later',
        );
    });
});

describe('encryptSecrets disabled', () => {
    // No encryption key is configured: on Vendure 3.8 and later the server must still start.
    const env = startServer();

    beforeAll(async () => {
        await setupPaymentMethod(env, {});
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await env.server.destroy();
    });

    it('stores the credentials in plain text', async () => {
        expect(await getStoredArgs(env)).toEqual({ apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET });
    });

    it('uses the credentials', async () => {
        const { client } = await getClient(env);
        expect(client.webhookSecret).toBe(WEBHOOK_SECRET);
        await expectWebhookVerifiesWith(env, WEBHOOK_SECRET);
    });

    // Values encrypted while the option was on must not be sent to Stripe as ciphertext.
    it.runIf(supportsEncryption)('refuses to use credentials stored encrypted', async () => {
        await setStoredArgs(env, `${CIPHERTEXT_PREFIX}iv:tag:data`, WEBHOOK_SECRET);
        await expect(getClient(env)).rejects.toThrow(
            "The Stripe 'apiKey' is stored encrypted, but the StripePlugin `encryptSecrets` option is not enabled",
        );
        await setStoredArgs(env, API_KEY, WEBHOOK_SECRET);
    });
});

describe.runIf(supportsEncryption)('encryptSecrets enabled', () => {
    const env = startServer({
        encryptionStrategy:
            DefaultEncryptionStrategy &&
            new DefaultEncryptionStrategy({ secret: 'a-long-random-encryption-key-for-the-e2e-tests' }),
    });
    let paymentMethodId: string;

    beforeAll(async () => {
        paymentMethodId = await setupPaymentMethod(env, { encryptSecrets: true });
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await env.server.destroy();
    });

    it('stores both credentials as ciphertext', async () => {
        const stored = await getStoredArgs(env);
        expect(stored.apiKey.startsWith(CIPHERTEXT_PREFIX)).toBe(true);
        expect(stored.webhookSecret.startsWith(CIPHERTEXT_PREFIX)).toBe(true);
        expect(JSON.stringify(stored)).not.toContain(API_KEY);
        expect(JSON.stringify(stored)).not.toContain(WEBHOOK_SECRET);
    });

    it('gives the Stripe client the decrypted credentials', async () => {
        const { client } = await getClient(env);
        expect(client.webhookSecret).toBe(WEBHOOK_SECRET);
        await expectWebhookVerifiesWith(env, WEBHOOK_SECRET);
    });

    it('keeps the stored value when the redaction placeholder is submitted', async () => {
        const before = await getStoredArgs(env);
        await env.adminClient.query(updatePaymentMethodDocument, {
            input: {
                id: paymentMethodId,
                handler: handlerInput(REDACTED_PLACEHOLDER, REDACTED_PLACEHOLDER),
            },
        });
        expect(await getStoredArgs(env)).toEqual(before);
        await expectWebhookVerifiesWith(env, WEBHOOK_SECRET);
    });

    it('keeps working with values stored in plain text before encryption was enabled', async () => {
        await setStoredArgs(env, API_KEY, WEBHOOK_SECRET);
        const { client } = await getClient(env);
        expect(client.webhookSecret).toBe(WEBHOOK_SECRET);
        await expectWebhookVerifiesWith(env, WEBHOOK_SECRET);
    });

    it('does not encrypt plain text values when the redaction placeholder is submitted', async () => {
        await env.adminClient.query(updatePaymentMethodDocument, {
            input: {
                id: paymentMethodId,
                handler: handlerInput(REDACTED_PLACEHOLDER, REDACTED_PLACEHOLDER),
            },
        });
        expect(await getStoredArgs(env)).toEqual({ apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET });
    });

    it('encrypts plain text values when a new value is saved', async () => {
        await env.adminClient.query(updatePaymentMethodDocument, {
            input: { id: paymentMethodId, handler: handlerInput(API_KEY, WEBHOOK_SECRET) },
        });
        const stored = await getStoredArgs(env);
        expect(stored.apiKey.startsWith(CIPHERTEXT_PREFIX)).toBe(true);
        expect(stored.webhookSecret.startsWith(CIPHERTEXT_PREFIX)).toBe(true);
        await expectWebhookVerifiesWith(env, WEBHOOK_SECRET);
    });
});
