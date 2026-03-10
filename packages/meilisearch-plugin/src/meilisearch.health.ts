import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';

import { MeilisearchService } from './meilisearch.service';

@Injectable()
export class MeilisearchHealthIndicator extends HealthIndicator {
    constructor(private meilisearchService: MeilisearchService) {
        super();
    }

    async isHealthy(): Promise<HealthIndicatorResult> {
        let isHealthy = false;
        let error = '';
        try {
            await this.meilisearchService.checkConnection();
            isHealthy = true;
        } catch (e: any) {
            error = e.message;
        }
        const result = this.getStatus('meilisearch', isHealthy, { message: error });
        if (isHealthy) {
            return result;
        }
        this.throwHealthCheckError(result);
    }

    startupCheckFailed(message: string): never {
        const result = this.getStatus('meilisearch', false, { message });
        return this.throwHealthCheckError(result);
    }

    private throwHealthCheckError(result: HealthIndicatorResult): never {
        throw new HealthCheckError('Meilisearch not available', result);
    }
}
