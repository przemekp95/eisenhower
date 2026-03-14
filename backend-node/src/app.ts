import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { loadConfig } from './config';
import { getDatabaseStatus } from './db';
import { createHealthRouter } from './routes/health';
import { createTasksRouter } from './routes/tasks';
import { HealthState } from './types';

export interface CreateAppOptions {
  aiHealthChecker?: () => Promise<HealthState>;
  databaseStatusResolver?: () => 'connected' | 'disconnected';
}

export async function defaultAiHealthChecker(url = loadConfig().aiServiceUrl): Promise<HealthState> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });

    return response.ok ? 'healthy' : 'unhealthy';
  } catch {
    return 'unreachable';
  }
}

export function createApp(options: CreateAppOptions = {}) {
  const config = loadConfig();
  const app = express();

  app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'test') {
      next();
      return;
    }

    const path = req.originalUrl.split('?')[0];
    if ((path === '/health' || path === '/health/ready') || req.method === 'OPTIONS') {
      next();
      return;
    }

    const startedAt = Date.now();

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const message = `backend-node ${req.method} ${path} ${res.statusCode} ${durationMs}ms`;

      if (res.statusCode >= 500) {
        console.error(message);
        return;
      }

      console.info(message);
    });

    next();
  });
  app.use(helmet());
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
  app.use(cors());
  app.use(express.json());

  app.use('/tasks', createTasksRouter());
  app.use(
    '/health',
    createHealthRouter({
      aiHealthChecker: options.aiHealthChecker ?? (() => defaultAiHealthChecker(config.aiServiceUrl)),
      databaseStatusResolver: options.databaseStatusResolver ?? getDatabaseStatus,
    })
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  });

  return app;
}
