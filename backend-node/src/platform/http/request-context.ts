import { randomUUID } from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthPrincipal } from '../../auth';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  startedAtMs: number;
  origin?: string;
  principal?: AuthPrincipal;
}

declare module 'fastify' {
  interface FastifyRequest {
    eisenhowerContext: RequestContext | null;
  }
}

export function attachRequestContext(request: FastifyRequest, reply: FastifyReply) {
  const supplied = request.headers['x-request-id'];
  const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
  const requestId = typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : randomUUID();
  const origin = request.headers.origin;
  const context: RequestContext = {
    requestId,
    method: request.method,
    path: request.url.split('?')[0],
    startedAtMs: Date.now(),
    ...(typeof origin === 'string' ? { origin } : {}),
  };
  request.eisenhowerContext = context;
  reply.header('X-Request-ID', requestId);
}

export function requestContextFor(request: FastifyRequest): RequestContext {
  const context = request.eisenhowerContext;
  if (!context) throw new Error('Request context is unavailable');
  return context;
}
