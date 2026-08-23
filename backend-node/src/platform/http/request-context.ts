import { randomUUID } from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthPrincipal } from '../../auth';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const contexts = new WeakMap<FastifyRequest, RequestContext>();

export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  origin?: string;
  principal?: AuthPrincipal;
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
    ...(typeof origin === 'string' ? { origin } : {}),
  };
  contexts.set(request, context);
  reply.header('X-Request-ID', requestId);
}

export function requestContextFor(request: FastifyRequest): RequestContext {
  const context = contexts.get(request);
  if (!context) throw new Error('Request context is unavailable');
  return context;
}
