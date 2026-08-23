import { FastifyAdapter } from '@nestjs/platform-fastify';

export const NODE_JSON_BODY_LIMIT = 32 * 1024;

export function createFastifyAdapter(nodeEnv: string) {
  return new FastifyAdapter({
    bodyLimit: NODE_JSON_BODY_LIMIT,
    trustProxy: nodeEnv === 'production' ? 1 : false,
    requestIdHeader: false,
  });
}
