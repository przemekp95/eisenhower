import { FastifyAdapter } from '@nestjs/platform-fastify';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { CreateAppOptions } from '../../app-options';
import { AppConfig } from '../../config';
import { attachRequestContext } from './request-context';

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
  fastify.addHook('onRequest', async (request, reply) => {
    attachRequestContext(request, reply);
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
    return payload;
  });
  await fastify.register(cors, {
    origin: config.corsAllowOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'Idempotency-Key', 'X-Request-ID'],
    exposedHeaders: ['ETag', 'X-Next-Cursor', 'Link', 'X-Request-ID'],
  });
}
