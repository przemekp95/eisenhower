import { Inject, Injectable } from '@nestjs/common';
import { loadConfig } from '../../config';
import { AI_HEALTH_CHECKER, DATABASE_STATUS_RESOLVER } from '../../platform/tokens';
import { DatabaseState, HealthState } from '../../types';

const DEFAULT_AI_READINESS_TIMEOUT_MS = 3_000;

export async function defaultAiHealthChecker(
  url = loadConfig().aiServiceUrl,
  timeoutMs = DEFAULT_AI_READINESS_TIMEOUT_MS,
): Promise<HealthState> {
  try {
    const readinessUrl = `${url.replace(/\/+$/, '')}/health/ready`;
    const response = await fetch(readinessUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? 'healthy' : 'unhealthy';
  } catch {
    return 'unreachable';
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(AI_HEALTH_CHECKER)
    private readonly aiHealthChecker: () => Promise<HealthState>,
    @Inject(DATABASE_STATUS_RESOLVER)
    private readonly databaseStatusResolver: () => DatabaseState,
  ) {}

  liveness() {
    return { status: 'ok' as const };
  }

  async readiness() {
    const database = this.databaseStatusResolver();
    let ai: HealthState;
    try {
      ai = await this.aiHealthChecker();
    } catch {
      ai = 'unreachable';
    }
    const ready = database === 'connected';
    return {
      statusCode: ready ? 200 : 503,
      body: {
        status: ready ? 'ready' as const : 'not_ready' as const,
        degraded: !ready || ai !== 'healthy',
        dependencies: { database, ai },
      },
    };
  }
}
