import { Router } from 'express';
import { DatabaseState, HealthState } from '../types';

export interface HealthDependencies {
  aiHealthChecker: () => Promise<HealthState>;
  databaseStatusResolver: () => DatabaseState;
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
      const status = database === 'connected' ? 'healthy' : 'unhealthy';

      res.status(status === 'healthy' ? 200 : 503).json({
        status,
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
