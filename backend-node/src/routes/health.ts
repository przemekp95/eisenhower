import { Router } from 'express';
import { DatabaseState, HealthState } from '../types';

export interface HealthDependencies {
  aiHealthChecker: () => Promise<HealthState>;
  databaseStatusResolver: () => DatabaseState;
}

function resolveReadiness(database: DatabaseState, ai: HealthState) {
  return database === 'connected' && ai === 'healthy';
}

export function createHealthRouter({
  aiHealthChecker,
  databaseStatusResolver,
}: HealthDependencies) {
  const router = Router();

  router.get('/', async (_req, res, next) => {
    try {
      const database = databaseStatusResolver();
      const ai = await aiHealthChecker();

      res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
          database,
          ai,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/ready', async (_req, res, next) => {
    try {
      const database = databaseStatusResolver();
      const ai = await aiHealthChecker();
      const ready = resolveReadiness(database, ai);

      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        timestamp: new Date().toISOString(),
        services: {
          database,
          ai,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
