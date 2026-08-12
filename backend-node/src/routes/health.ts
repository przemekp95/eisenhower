import { Router } from 'express';
import { DatabaseState, HealthState } from '../types';

export interface HealthDependencies {
  aiHealthChecker: () => Promise<HealthState>;
  databaseStatusResolver: () => DatabaseState;
}

function resolveReadiness(database: DatabaseState, ai: HealthState) {
  return {
    ready: database === 'connected',
    degraded: database !== 'connected' || ai !== 'healthy',
  };
}

export function createHealthRouter({
  aiHealthChecker,
  databaseStatusResolver,
}: HealthDependencies) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res, next) => {
    try {
      const database = databaseStatusResolver();
      let ai: HealthState;
      try {
        ai = await aiHealthChecker();
      } catch {
        ai = 'unreachable';
      }
      const { ready, degraded } = resolveReadiness(database, ai);

      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        degraded,
        dependencies: { database, ai },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
