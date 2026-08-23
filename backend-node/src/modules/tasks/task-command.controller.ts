import {
  Body, Controller, Delete, Headers, Inject, Param, Post, Put, Req, Res, UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { TaskCommandService } from '../../application/tasks/task-command.service';
import { taskCommandError } from '../../application/tasks/task-errors';
import type {
  TaskDelegationAssignment, TaskDelegationStatus, TaskLifecycleAction, TaskPayload, TaskSchedule,
} from '../../application/taskRepository';
import { requestContextFor } from '../../platform/http/request-context';
import { RequiredScopes } from '../security/security.decorators';
import {
  CreateTaskDto, DelegationStatusTaskDto, DelegationTaskDto, LifecycleTaskDto,
  ScheduleTaskDto, UpdateTaskDto,
} from './task-command.dto';
import { TaskIdPipe, TaskValidationPipe } from './task-validation.pipe';
import { TaskInvalidIdAggregationGuard } from './task-invalid-id.guard';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function revision(value: string | undefined) {
  if (value === undefined) {
    throw taskCommandError(
      428, 'If-Match is required for task mutations', 'precondition_required',
    );
  }
  const match = /^"(\d+)"$/.exec(value.trim());
  const parsed = match ? Number(match[1]) : Number.NaN;
  if (!match || !Number.isSafeInteger(parsed)) {
    throw taskCommandError(400, 'If-Match must contain a strong quoted numeric task revision');
  }
  return parsed;
}

function idempotencyKey(value: string | undefined) {
  if (value !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw taskCommandError(400, 'Idempotency-Key must contain 1-128 URL-safe characters');
  }
  return value;
}

@Controller('tasks')
@UseGuards(new TaskInvalidIdAggregationGuard())
export class TaskCommandController {
  constructor(@Inject(TaskCommandService) private readonly commands: TaskCommandService) {}

  @Post()
  @RequiredScopes('tasks:write')
  async create(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body(new TaskValidationPipe(CreateTaskDto)) body: CreateTaskDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const result = await this.commands.create(
      requestContextFor(request).principal!, body as TaskPayload, idempotencyKey(key),
    );
    reply.status(result.status).header('ETag', `"${result.task.revision}"`);
    if (result.idempotencyReplayed) reply.header('Idempotency-Replayed', 'true');
    return result.task;
  }

  @Put(':id')
  @RequiredScopes('tasks:write')
  async update(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', new TaskIdPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new TaskValidationPipe(UpdateTaskDto)) body: UpdateTaskDto,
  ) {
    const task = await this.commands.update(
      requestContextFor(request).principal!, id, revision(ifMatch), body,
    );
    reply.header('ETag', `"${task.revision}"`);
    return task;
  }

  @Put(':id/lifecycle')
  @RequiredScopes('tasks:write')
  async lifecycle(
    @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', new TaskIdPipe()) id: string, @Headers('if-match') ifMatch: string | undefined,
    @Body(new TaskValidationPipe(LifecycleTaskDto)) body: LifecycleTaskDto,
  ) {
    const task = await this.commands.transitionLifecycle(
      requestContextFor(request).principal!, id, revision(ifMatch), body.action as TaskLifecycleAction,
    );
    reply.header('ETag', `"${task.revision}"`);
    return task;
  }

  @Put(':id/schedule')
  @RequiredScopes('tasks:write')
  async schedule(
    @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', new TaskIdPipe()) id: string, @Headers('if-match') ifMatch: string | undefined,
    @Body(new TaskValidationPipe(ScheduleTaskDto)) body: ScheduleTaskDto,
  ) {
    const raw = body.schedule as null | {
      dueAt: string; timeZone: string; remindAt?: string; durationMinutes?: number;
    };
    const schedule: TaskSchedule | null = raw === null ? null : {
      dueAt: new Date(raw.dueAt), timeZone: raw.timeZone,
      durationMinutes: raw.durationMinutes ?? 30,
      ...(raw.remindAt ? { remindAt: new Date(raw.remindAt) } : {}),
    };
    const task = await this.commands.updateSchedule(
      requestContextFor(request).principal!, id, revision(ifMatch), schedule,
    );
    reply.header('ETag', `"${task.revision}"`);
    return task;
  }

  @Put(':id/delegation')
  @RequiredScopes('tasks:write')
  async delegation(
    @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', new TaskIdPipe()) id: string, @Headers('if-match') ifMatch: string | undefined,
    @Body(new TaskValidationPipe(DelegationTaskDto)) body: DelegationTaskDto,
  ) {
    const task = await this.commands.updateDelegation(
      requestContextFor(request).principal!, id, revision(ifMatch),
      body.delegation as TaskDelegationAssignment | null,
    );
    reply.header('ETag', `"${task.revision}"`);
    return task;
  }

  @Put(':id/delegation/status')
  @RequiredScopes('tasks:write')
  async delegationStatus(
    @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id', new TaskIdPipe()) id: string, @Headers('if-match') ifMatch: string | undefined,
    @Body(new TaskValidationPipe(DelegationStatusTaskDto)) body: DelegationStatusTaskDto,
  ) {
    const task = await this.commands.transitionDelegation(
      requestContextFor(request).principal!, id, revision(ifMatch),
      body.status as TaskDelegationStatus,
    );
    reply.header('ETag', `"${task.revision}"`);
    return task;
  }

  @Delete(':id')
  @RequiredScopes('tasks:write')
  async delete(
    @Req() request: FastifyRequest, @Res() reply: FastifyReply,
    @Param('id', new TaskIdPipe()) id: string, @Headers('if-match') ifMatch: string | undefined,
  ) {
    await this.commands.delete(requestContextFor(request).principal!, id, revision(ifMatch));
    return reply.status(204).send();
  }
}
