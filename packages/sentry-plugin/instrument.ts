import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

type ConsoleLevel = NonNullable<
    NonNullable<Parameters<typeof Sentry.consoleLoggingIntegration>[0]>['levels']
>[number];

const SENTRY_DSN = process.env.SENTRY_DSN;
const SENTRY_TRACES_SAMPLE_RATE = process.env.SENTRY_TRACES_SAMPLE_RATE
    ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
    : undefined;
const SENTRY_PROFILES_SAMPLE_RATE = process.env.SENTRY_PROFILES_SAMPLE_RATE
    ? Number(process.env.SENTRY_PROFILES_SAMPLE_RATE)
    : undefined;
const SENTRY_ENABLE_LOGS = process.env.SENTRY_ENABLE_LOGS === 'true';
const SENTRY_CAPTURE_LOG_LEVELS = process.env.SENTRY_CAPTURE_LOG_LEVELS
    ? process.env.SENTRY_CAPTURE_LOG_LEVELS.split(',').map(l => l.trim())
    : ['log', 'warn', 'error'];

/**
 * Headers and query params whose names contain one of these fragments are dropped.
 * This is the list the Sentry SDK v10 applied when `sendDefaultPii` was off.
 */
const PII_DENY_LIST = ['forwarded', '-ip', 'remote-', 'via', '-user'];

if (!SENTRY_DSN) {
    // eslint-disable-next-line
    console.error('SENTRY_DSN is not set');
} else {
    Sentry.init({
        dsn: SENTRY_DSN,
        integrations: [
            nodeProfilingIntegration(),
            // Since SDK v11 logs are captured whenever a logging integration is installed,
            // so SENTRY_ENABLE_LOGS decides whether to add it.
            ...(SENTRY_ENABLE_LOGS
                ? [Sentry.consoleLoggingIntegration({ levels: SENTRY_CAPTURE_LOG_LEVELS as ConsoleLevel[] })]
                : []),
        ],
        /**
         * @description
         * The sample rate for tracing. Value should be between 0 and 1.
         * By default, tracing is disabled.
         * @default undefined
         */
        tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
        /**
         * @description
         * The sample rate for profiling. Value should be between 0 and 1.
         * A sampled profile runs for the lifetime of each sampled trace.
         * By default, profiling is disabled.
         * @default undefined
         */
        profileSessionSampleRate: SENTRY_PROFILES_SAMPLE_RATE,
        profileLifecycle: 'trace',
        /**
         * @description
         * Leaving `dataCollection` unset makes SDK v11 collect request and response bodies,
         * cookies, user info and database query data. A commerce server handles passwords,
         * addresses and payment data in exactly those places, so this keeps the restrictive
         * defaults of SDK v10.
         */
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: {
                request: { deny: PII_DENY_LIST },
                response: { deny: PII_DENY_LIST },
            },
            httpBodies: [],
            urlQueryParams: { deny: PII_DENY_LIST },
            genAI: { inputs: false, outputs: false },
            databaseQueryData: false,
            queues: false,
            graphQL: { document: false, variables: false },
        },
    });
}
