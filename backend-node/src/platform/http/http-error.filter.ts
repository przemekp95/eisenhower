import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import type { FastifyRequest } from 'fastify';
import { TaskQueryError } from '../../application/tasks/task-query.errors';
import { TaskCommandError } from '../../application/tasks/task-errors';
import {
  INTERNAL_HMAC_CONTEXT, InternalHmacReplay, InternalHmacRequest,
} from '../../modules/calendar-internal/internal-hmac.service';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly production: boolean) {}

  async catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest & InternalHmacRequest>();
    const send = async (status: number, body?: unknown, type?: string) => {
      const context = request[INTERNAL_HMAC_CONTEXT];
      await context?.service.complete(context, status, body);
      if (type) response.type(type);
      response.status(status).send(body);
    };
    if (error instanceof InternalHmacReplay) {
      await send(error.statusCode, error.responseBody);
      return;
    }
    if (error instanceof TaskQueryError) {
      await send(error.status, error.body);
      return;
    }
    if (error instanceof TaskCommandError) {
      await send(error.status, error.body);
      return;
    }
    if (
      error && typeof error === 'object'
      && ('statusCode' in error || 'code' in error)
    ) {
      const statusCode = 'statusCode' in error ? Number(error.statusCode) : 0;
      const code = 'code' in error ? String(error.code) : '';
      if (statusCode === 413 || code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        await send(413, { error: 'Request body too large' });
        return;
      }
      if (statusCode === 429 || code === 'EISENHOWER_RATE_LIMITED') {
        await send(429, 'Too many requests, please try again later.', 'text/html; charset=utf-8');
        return;
      }
    }
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const body = error.getResponse();
      if (
        status === HttpStatus.NOT_FOUND
        && typeof body === 'object'
        && body !== null
        && 'message' in body
        && typeof body.message === 'string'
        && body.message.startsWith('Cannot ')
      ) {
        await send(status, { error: 'Route not found' });
        return;
      }
      await send(status, body);
      return;
    }

    const message = error instanceof Error ? error.message : 'Internal server error';
    await send(HttpStatus.INTERNAL_SERVER_ERROR, {
      error: this.production ? 'Internal server error' : message,
    });
  }
}
