import { Inject, Injectable } from '@nestjs/common';
import type { CaptureContext } from '@sentry/nestjs';
import * as Sentry from '@sentry/nestjs';

import { SENTRY_PLUGIN_OPTIONS } from './constants';
import { SentryPluginOptions } from './types';

type StartSpanOptions = Parameters<typeof Sentry.startSpanManual>[0];

/**
 * @description
 * Service for capturing errors and messages to Sentry.
 * @docsCategory SentryPlugin
 */
@Injectable()
export class SentryService {
    constructor(@Inject(SENTRY_PLUGIN_OPTIONS) private options: SentryPluginOptions) {}

    captureException(exception: Error) {
        Sentry.captureException(exception);
    }

    /**
     * @description
     * Captures a message
     * @param message - The message to capture
     * @param captureContext - The capture context
     */
    captureMessage(message: string, captureContext?: CaptureContext) {
        Sentry.captureMessage(message, captureContext);
    }

    /**
     * @description
     * Starts new span
     */
    startSpan(context: StartSpanOptions) {
        return Sentry.startSpanManual(context, span => span);
    }
}
