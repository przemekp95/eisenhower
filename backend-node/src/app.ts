import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit, { Store } from 'express-rate-limit';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuditSink, DurableFileAuditSink, StructuredStdoutAuditSink } from './audit';
import { loadConfig } from './config';
import { getDatabaseStatus } from './db';
import { createHealthRouter } from './routes/health';
import { createTasksRouter } from './routes/tasks';
import { TaskRepository } from './application/taskRepository';
import { MongooseTaskRepository } from './repositories/mongooseTaskRepository';
import { createCalendarInternalRouter } from './routes/calendarInternal';
import { createCalendarRouter } from './routes/calendar';
import { CalendarApplicationService } from './application/calendar';
import { createGoogleOAuthCallbackRouter, createGoogleOAuthUserRouter } from './routes/googleOAuth';
import {
  GoogleOAuthConfig, GoogleOAuthHttpClient, GoogleOAuthPort, GoogleOAuthService, loadGoogleOAuthConfig,
} from './application/googleOAuth';
import {
  GoogleCalendarConfig, GoogleCalendarHttpAdapter, GoogleCalendarPort, GoogleCalendarService,
  loadGoogleCalendarConfig,
} from './application/googleCalendar';
import { createGoogleCalendarProviderRouter } from './routes/googleCalendarProvider';
import { HealthState } from './types';
import {
  createOidcTokenVerifier,
  OidcTokenVerifier,
  requireBearerToken,
  requireOidcToken,
  requireTaskScope,
  requireTrustedBrowserOrigin,
} from './auth';

export interface CreateAppOptions {
  aiHealthChecker?: () => Promise<HealthState>;
  databaseStatusResolver?: () => 'connected' | 'disconnected';
  redisStatusResolver?: () => 'connected' | 'disconnected';
  rateLimitLimit?: number;
  rateLimitStore?: Store;
  auditSink?: AuditSink;
  calendarInternalHmacKey?: string;
  googleOAuthConfig?: GoogleOAuthConfig;
  googleOAuthPort?: GoogleOAuthPort;
  googleCalendarPort?: GoogleCalendarPort;
  googleCalendarConfig?: GoogleCalendarConfig;
  oidcTokenVerifier?: OidcTokenVerifier;
  taskRepository?: TaskRepository;
  calendarEnabled?: boolean;
  logSink?: (level: 'info' | 'error', event: Record<string, unknown>) => void;
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
  const auditSinkMode = process.env.AUDIT_SINK ?? 'file';
  if (config.nodeEnv === 'production' && (
    !['file', 'stdout'].includes(auditSinkMode)
    || (auditSinkMode === 'file' && !process.env.AUDIT_LOG_PATH)
    || !process.env.AUDIT_HMAC_KEY
    || Buffer.byteLength(process.env.AUDIT_HMAC_KEY) < 32
    || !process.env.RELEASE_SHA
    || !/^[a-f0-9]{40}$/.test(process.env.RELEASE_SHA)
  )) {
    throw new Error('A durable AUDIT_SINK (and AUDIT_LOG_PATH for file mode), strong AUDIT_HMAC_KEY, and exact RELEASE_SHA are required in production.');
  }
  const auditKey = process.env.AUDIT_HMAC_KEY ?? 'development-node-audit-key-change-me-now';
  const auditSink = options.auditSink ?? (auditSinkMode === 'stdout'
    ? new StructuredStdoutAuditSink(auditKey)
    : new DurableFileAuditSink(
      process.env.AUDIT_LOG_PATH ?? path.join(os.tmpdir(), `eisenhower-node-audit-${process.pid}.ndjson`),
      auditKey,
    ));
  const releaseSha = process.env.RELEASE_SHA ?? '0'.repeat(40);
  const logSink = options.logSink ?? ((level: 'info' | 'error', event: Record<string, unknown>) => {
    const line = JSON.stringify(event);
    if (level === 'error') console.error(line);
    else console.info(line);
  });
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
    if (process.env.NODE_ENV === 'test' && !options.logSink) {
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
      logSink(res.statusCode >= 500 ? 'error' : 'info', {
        timestamp: new Date().toISOString(),
        event: 'http_request_completed',
        service: 'backend-node',
        releaseSha,
        requestId: req.requestId,
        method: req.method,
        path,
        statusCode: res.statusCode,
        durationMs,
      });
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
      ...(options.rateLimitStore ? { store: options.rateLimitStore } : {}),
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
  app.use(express.json({
    limit: '32kb',
    verify: (request, _response, buffer) => {
      (request as Request).rawBody = Buffer.from(buffer);
    },
  }));

  app.use(
    '/health',
    createHealthRouter({
      aiHealthChecker: options.aiHealthChecker ?? (() => defaultAiHealthChecker(config.aiServiceUrl)),
      databaseStatusResolver: options.databaseStatusResolver ?? getDatabaseStatus,
      redisStatusResolver: options.redisStatusResolver,
    })
  );

  const calendarEnabled = options.calendarEnabled ?? true;
  const calendarInternalHmacKey = calendarEnabled
    ? (options.calendarInternalHmacKey ?? process.env.CALENDAR_INTERNAL_HMAC_KEY)
    : undefined;
  if (calendarInternalHmacKey) {
    if (Buffer.byteLength(calendarInternalHmacKey) < 32) {
      throw new Error('CALENDAR_INTERNAL_HMAC_KEY must contain at least 32 bytes.');
    }
    app.use('/internal/calendar', createCalendarInternalRouter(calendarInternalHmacKey));
  }

  const googleOAuthConfig = calendarEnabled
    ? (options.googleOAuthConfig ?? loadGoogleOAuthConfig(process.env, config.nodeEnv))
    : null;
  const googleOAuthService = googleOAuthConfig
    ? new GoogleOAuthService(googleOAuthConfig, options.googleOAuthPort ?? new GoogleOAuthHttpClient())
    : null;
  if (googleOAuthService) {
    app.use('/calendar/oauth', createGoogleOAuthCallbackRouter(googleOAuthService));
  }
  const googleCalendarConfig = calendarEnabled
    ? (options.googleCalendarConfig ?? loadGoogleCalendarConfig(process.env))
    : null;
  if (calendarInternalHmacKey && googleOAuthConfig && googleCalendarConfig) {
    app.use('/internal/calendar/provider', createGoogleCalendarProviderRouter(
      calendarInternalHmacKey,
      new GoogleCalendarService(
        googleOAuthConfig, googleCalendarConfig, options.googleCalendarPort ?? new GoogleCalendarHttpAdapter(),
      ),
    ));
  }

  if (config.authMode === 'oidc') {
    const oidcTokenVerifier = options.oidcTokenVerifier ?? createOidcTokenVerifier({
      issuer: config.oidcIssuer!, audience: config.oidcAudience!, jwksUrl: config.oidcJwksUrl!,
    });
    app.use(requireOidcToken(oidcTokenVerifier, auditRejection));
  } else {
    app.use(requireBearerToken(config.apiToken, auditRejection));
  }

  app.use(requireTrustedBrowserOrigin(config.corsAllowOrigins, auditRejection));
  const taskRepository = options.taskRepository ?? new MongooseTaskRepository();
  app.use('/tasks', requireTaskScope(auditRejection), createTasksRouter(taskRepository));
  // The ALB routes /api/* without rewriting the path. Keep the historical
  // direct /tasks contract while exposing the identical repository-backed API.
  app.use('/api/tasks', requireTaskScope(auditRejection), createTasksRouter(taskRepository));
  if (calendarEnabled) {
    app.use('/calendar', createCalendarRouter(
      auditRejection,
      new CalendarApplicationService(),
      Boolean(googleOAuthService),
    ));
    if (googleOAuthService) {
      app.use('/calendar/oauth', createGoogleOAuthUserRouter(googleOAuthService, auditRejection));
    }
  }

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
