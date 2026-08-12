import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuditSink, DurableFileAuditSink } from './audit';
import { loadConfig } from './config';
import { getDatabaseStatus } from './db';
import { createHealthRouter } from './routes/health';
import { createTasksRouter } from './routes/tasks';
import { HealthState } from './types';
import {
  createOidcTokenVerifier,
  requireBearerToken,
  requireOidcToken,
  requireTrustedBrowserOrigin,
} from './auth';

export interface CreateAppOptions {
  aiHealthChecker?: () => Promise<HealthState>;
  databaseStatusResolver?: () => 'connected' | 'disconnected';
  rateLimitLimit?: number;
  auditSink?: AuditSink;
}

const DEFAULT_AI_READINESS_TIMEOUT_MS = 3_000;

export async function defaultAiHealthChecker(
  url = loadConfig().aiServiceUrl,
  timeoutMs = DEFAULT_AI_READINESS_TIMEOUT_MS,
): Promise<HealthState> {
  try {
    const readinessUrl = `${url.replace(/\/+$/, '')}/health/ready`;
    const response = await fetch(readinessUrl, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    return response.ok ? 'healthy' : 'unhealthy';
  } catch {
    return 'unreachable';
  }
}

export function createApp(options: CreateAppOptions = {}) {
  const config = loadConfig();
  const app = express();
  if (config.nodeEnv === 'production' && (
    !process.env.AUDIT_LOG_PATH
    || !process.env.AUDIT_HMAC_KEY
    || Buffer.byteLength(process.env.AUDIT_HMAC_KEY) < 32
    || !process.env.RELEASE_SHA
    || !/^[a-f0-9]{40}$/.test(process.env.RELEASE_SHA)
  )) {
    throw new Error('AUDIT_LOG_PATH, a strong AUDIT_HMAC_KEY, and exact RELEASE_SHA are required in production.');
  }
  const auditSink = options.auditSink ?? new DurableFileAuditSink(
    process.env.AUDIT_LOG_PATH ?? path.join(os.tmpdir(), `eisenhower-node-audit-${process.pid}.ndjson`),
    process.env.AUDIT_HMAC_KEY ?? 'development-node-audit-key-change-me-now',
  );
  const releaseSha = process.env.RELEASE_SHA ?? '0'.repeat(40);
  const auditRejection = (request: Request, action: 'auth_rejection' | 'acl_rejection') => {
    auditSink.record({
      service: 'backend-node',
      releaseSha,
      requestId: request.requestId,
      action,
      outcome: 'rejected',
      tenantId: request.auth?.tenantId ?? 'unknown',
      actorId: request.auth?.userId ?? 'anonymous',
      resourceId: request.path,
    });
  };

  app.use((request, response, next) => {
    const supplied = request.get('x-request-id') ?? '';
    request.requestId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(supplied)
      ? supplied
      : randomUUID();
    response.set('X-Request-ID', request.requestId);
    next();
  });

  // Production traffic reaches Node through exactly one repository-controlled
  // frontend nginx hop. Development exposes Node directly and trusts no proxy.
  app.set('trust proxy', config.nodeEnv === 'production' ? 1 : false);

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
      limit: options.rateLimitLimit ?? 120,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
  app.use(
    cors({
      origin: config.corsAllowOrigins,
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'Idempotency-Key', 'X-Request-ID'],
      exposedHeaders: ['ETag', 'X-Next-Cursor', 'Link', 'X-Request-ID'],
    })
  );
  app.use(express.json({ limit: '32kb' }));

  app.use(
    '/health',
    createHealthRouter({
      aiHealthChecker: options.aiHealthChecker ?? (() => defaultAiHealthChecker(config.aiServiceUrl)),
      databaseStatusResolver: options.databaseStatusResolver ?? getDatabaseStatus,
    })
  );

  if (config.authMode === 'oidc') {
    app.use(requireOidcToken(createOidcTokenVerifier({
      issuer: config.oidcIssuer!,
      audience: config.oidcAudience!,
      jwksUrl: config.oidcJwksUrl!,
    }), auditRejection));
  } else {
    app.use(requireBearerToken(config.apiToken, auditRejection));
  }

  app.use(requireTrustedBrowserOrigin(config.corsAllowOrigins, auditRejection));
  app.use('/tasks', createTasksRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (
      error instanceof Error &&
      'type' in error &&
      error.type === 'entity.too.large'
    ) {
      res.status(413).json({ error: 'Request body too large' });
      return;
    }

    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: config.nodeEnv === 'production' ? 'Internal server error' : message });
  });

  return app;
}
