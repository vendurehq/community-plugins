import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';

import { OpenSearchService } from './opensearch.service';

/**
 * @deprecated Use infrastructure-level health checks instead of application-level health checks.
 * This class will be removed in v4.0.0.
 */
@Injectable()
export class OpenSearchHealthIndicator extends HealthIndicator {
    constructor(private opensearchService: OpenSearchService) {
        super();
    }

    async isHealthy(): Promise<HealthIndicatorResult> {
        let isHealthy = false;
        let error = '';
        try {
            await this.opensearchService.checkConnection();
            isHealthy = true;
        } catch (e: any) {
            error = e.message;
        }
        const result = this.getStatus('opensearch', isHealthy, { message: error });
        if (isHealthy) {
            return result;
        }
        this.throwHealthCheckError(result);
    }

    startupCheckFailed(message: string): never {
        const result = this.getStatus('opensearch', false, { message });
        return this.throwHealthCheckError(result);
    }

    private throwHealthCheckError(result: HealthIndicatorResult): never {
        throw new HealthCheckError('OpenSearch not available', result);
    }
}
