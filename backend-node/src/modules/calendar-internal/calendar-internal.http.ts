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
  try {
    await context?.service.complete(context, result.status, result.body);
  } catch {
    // Preserve the completed operation response; claimOutbox performs its
    // receipt update atomically with the lease when that coupling is required.
  }
  reply.status(result.status);
  return result.body === undefined ? reply.send() : reply.send(result.body);
}
