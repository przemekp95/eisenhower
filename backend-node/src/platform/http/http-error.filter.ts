import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly production: boolean) {}

  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<FastifyReply>();
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
      if (status === HttpStatus.NOT_FOUND) {
        response.status(status).send({ error: 'Route not found' });
        return;
      }
      response.status(status).send(error.getResponse());
      return;
    }

    const message = error instanceof Error ? error.message : 'Internal server error';
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: this.production ? 'Internal server error' : message,
    });
  }
}
