import { Router } from 'express';
import { DatabaseState, HealthState } from '../types';

export interface HealthDependencies {
  aiHealthChecker: () => Promise<HealthState>;
  databaseStatusResolver: () => DatabaseState;
  redisStatusResolver?: () => DatabaseState;
}

function resolveReadiness(database: DatabaseState, ai: HealthState, redis?: DatabaseState) {
  return {
    ready: database === 'connected' && (redis === undefined || redis === 'connected'),
    degraded: database !== 'connected' || ai !== 'healthy' || redis === 'disconnected',
  };
}

export function createHealthRouter({
  aiHealthChecker,
  databaseStatusResolver,
  redisStatusResolver,
}: HealthDependencies) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res, next) => {
    try {
      const database = databaseStatusResolver();
      const redis = redisStatusResolver?.();
      let ai: HealthState;
      try {
        ai = await aiHealthChecker();
      } catch {
        ai = 'unreachable';
      }
      const { ready, degraded } = resolveReadiness(database, ai, redis);

      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        degraded,
        dependencies: { database, ai, ...(redis === undefined ? {} : { redis }) },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
