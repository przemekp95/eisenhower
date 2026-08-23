import {
  CanActivate, ExecutionContext, HttpException, Inject, Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { INTERNAL_HMAC_SERVICE } from '../../platform/tokens';
import { InternalHmacService } from './internal-hmac.service';

@Injectable()
export class InternalHmacGuard implements CanActivate {
  constructor(@Inject(INTERNAL_HMAC_SERVICE) private readonly hmac: InternalHmacService) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest & { rawBody?: Buffer }>();
    const failure = this.hmac.verify({
      timestamp: String(request.headers['x-eisenhower-timestamp'] ?? ''),
      requestId: String(request.headers['x-eisenhower-request-id'] ?? ''),
      signature: String(request.headers['x-eisenhower-signature'] ?? ''),
      method: request.method,
      path: request.url.split('?')[0],
      rawBody: request.rawBody ?? Buffer.alloc(0),
    });
    if (!failure) return true;
    const errors = {
      timestamp: 'Invalid calendar dispatch timestamp',
      'request-id': 'Invalid calendar dispatch request id',
      signature: 'Invalid calendar dispatch signature',
    } as const;
    throw new HttpException({ error: errors[failure] }, 401);
  }
}
