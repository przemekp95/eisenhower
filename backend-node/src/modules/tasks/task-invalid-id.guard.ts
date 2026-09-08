import {
  BadRequestException, CanActivate, ExecutionContext, Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  DelegationStatusTaskDto, DelegationTaskDto, LifecycleTaskDto, ScheduleTaskDto, UpdateTaskDto,
} from './task-command.dto';
import { TaskValidationPipe } from './task-validation.pipe';

const INVALID_ID = /^[a-f0-9]{24}$/i;

@Injectable()
export class TaskInvalidIdAggregationGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const id = (request.params as { id?: string } | undefined)?.id;
    if (!id || INVALID_ID.test(id)) return true;
    const details = ['Invalid value'];
    if (request.method === 'PUT') {
      const path = request.url.split('?')[0];
      const dto = path.endsWith('/lifecycle') ? LifecycleTaskDto
        : path.endsWith('/schedule') ? ScheduleTaskDto
          : path.endsWith('/delegation/status') ? DelegationStatusTaskDto
            : path.endsWith('/delegation') ? DelegationTaskDto
              : UpdateTaskDto;
      try {
        new TaskValidationPipe().transform(request.body, { type: 'body', metatype: dto });
      } catch (error) {
        if (error instanceof BadRequestException) {
          const response = error.getResponse() as { details?: string[] };
          details.push(...(response.details ?? []));
        } else {
          throw error;
        }
      }
    }
    throw new BadRequestException({ error: 'Validation failed', details });
  }
}
