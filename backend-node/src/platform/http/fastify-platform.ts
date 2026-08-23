import { FastifyAdapter } from '@nestjs/platform-fastify';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createHash } from 'node:crypto';
import { CreateAppOptions } from '../../app-options';
import { AppConfig } from '../../config';
import { attachRequestContext, requestContextFor } from './request-context';

export const NODE_JSON_BODY_LIMIT = 32 * 1024;

export function createFastifyAdapter(nodeEnv: string) {
  return new FastifyAdapter({
    bodyLimit: NODE_JSON_BODY_LIMIT,
    trustProxy: nodeEnv === 'production' ? 1 : false,
    requestIdHeader: false,
  });
}

export async function registerFastifyPlatform(
  app: NestFastifyApplication,
  config: AppConfig,
  options: CreateAppOptions,
) {
  const fastify = app.getHttpAdapter().getInstance();
  fastify.decorateRequest('eisenhowerContext', null);
  fastify.addHook('onRequest', async (request, reply) => {
    attachRequestContext(request, reply);
  });
  fastify.addHook('onResponse', async (request, reply) => {
    if (config.nodeEnv === 'test' || request.method === 'OPTIONS') return;
    const path = request.url.split('?')[0];
    if (path === '/health' || path === '/health/ready') return;
    const durationMs = Date.now() - requestContextFor(request).startedAtMs;
    const message = `backend-node ${request.method} ${path} ${reply.statusCode} ${durationMs}ms`;
    if (reply.statusCode >= 500) console.error(message);
    else console.info(message);
  });
  await fastify.register(helmet);
  await fastify.register(rateLimit, {
    global: true,
    timeWindow: 60_000,
    max: options.rateLimitLimit ?? 120,
    enableDraftSpec: true,
    errorResponseBuilder: () => ({ statusCode: 429, code: 'EISENHOWER_RATE_LIMITED' }),
  });
  fastify.addHook('onSend', async (_request, reply, payload) => {
    const limit = reply.getHeader('ratelimit-limit');
    if (limit !== undefined) reply.header('RateLimit-Policy', `${limit};w=60`);
    if (reply.statusCode === 429 && limit !== undefined) {
      reply.type('text/html; charset=utf-8');
      return 'Too many requests, please try again later.';
    }
    if (reply.statusCode === 413) {
      reply.type('application/json; charset=utf-8');
      return JSON.stringify({ error: 'Request body too large' });
    }
    const exposed = reply.getHeader('access-control-expose-headers');
    if (typeof exposed === 'string') {
      reply.header('Access-Control-Expose-Headers', exposed.replace(/,\s+/g, ','));
    }
    if (
      payload !== undefined && payload !== null
      && reply.statusCode !== 204 && reply.statusCode !== 304
      && reply.getHeader('etag') === undefined
    ) {
      const entity = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
      const digest = createHash('sha1').update(entity).digest('base64').slice(0, 27);
      reply.header('ETag', `W/"${entity.length.toString(16)}-${digest}"`);
    }
    return payload;
  });
  await fastify.register(cors, {
    origin: config.corsAllowOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'Idempotency-Key', 'X-Request-ID'],
    exposedHeaders: ['ETag', 'X-Next-Cursor', 'Link', 'X-Request-ID'],
    strictPreflight: false,
  });
}
