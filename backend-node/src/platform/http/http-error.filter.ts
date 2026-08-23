import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly production: boolean) {}

  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<FastifyReply>();
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
