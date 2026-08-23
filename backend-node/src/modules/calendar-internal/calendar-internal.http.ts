import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InternalResult } from '../../application/calendarInternal';
import {
  INTERNAL_HMAC_CONTEXT, InternalHmacRequest,
} from './internal-hmac.service';

export async function sendInternalResult(
  request: FastifyRequest & InternalHmacRequest,
  reply: FastifyReply,
  result: InternalResult,
) {
  const context = request[INTERNAL_HMAC_CONTEXT];
  await context?.service.complete(context, result.status, result.body);
  reply.status(result.status);
  return result.body === undefined ? reply.send() : reply.send(result.body);
}
