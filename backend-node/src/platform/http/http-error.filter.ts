import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { TaskQueryError } from '../../application/tasks/task-query.errors';
import { TaskCommandError } from '../../application/tasks/task-errors';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly production: boolean) {}

  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    if (error instanceof TaskQueryError) {
      response.status(error.status).send(error.body);
      return;
    }
    if (error instanceof TaskCommandError) {
      response.status(error.status).send(error.body);
      return;
    }
    if (
      error && typeof error === 'object'
      && ('statusCode' in error || 'code' in error)
    ) {
      const statusCode = 'statusCode' in error ? Number(error.statusCode) : 0;
      const code = 'code' in error ? String(error.code) : '';
      if (statusCode === 413 || code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        response.status(413).send({ error: 'Request body too large' });
        return;
      }
      if (statusCode === 429 || code === 'EISENHOWER_RATE_LIMITED') {
        response.type('text/html; charset=utf-8').status(429)
          .send('Too many requests, please try again later.');
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
        response.status(status).send({ error: 'Route not found' });
        return;
      }
      response.status(status).send(body);
      return;
    }

    const message = error instanceof Error ? error.message : 'Internal server error';
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: this.production ? 'Internal server error' : message,
    });
  }
}
