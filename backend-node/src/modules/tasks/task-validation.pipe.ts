import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateTaskDto, DelegationStatusTaskDto, DelegationTaskDto, LifecycleTaskDto,
  ScheduleTaskDto, UpdateTaskDto,
} from './task-command.dto';

const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function fail(details: string[]): never {
  throw new BadRequestException({ error: 'Validation failed', details });
}

function objectBody(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(['Request body must be an object']);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: string[], message: string) {
  if (Object.keys(value).some((field) => !fields.includes(field))) fail([message]);
}

function validateSchedule(body: Record<string, unknown>) {
  exactFields(body, ['schedule'], 'Unexpected schedule request field');
  if (!Object.prototype.hasOwnProperty.call(body, 'schedule')) fail(['schedule is required']);
  if (body.schedule === null) return;
  if (!body.schedule || typeof body.schedule !== 'object' || Array.isArray(body.schedule)) {
    fail(['schedule must be an object or null']);
  }
  const schedule = body.schedule as Record<string, unknown>;
  exactFields(schedule, ['dueAt', 'timeZone', 'remindAt', 'durationMinutes'], 'Unexpected schedule field');
  if (typeof schedule.dueAt !== 'string' || typeof schedule.timeZone !== 'string') {
    fail(['dueAt and timeZone are required together']);
  }
  if (!UTC_ISO_PATTERN.test(schedule.dueAt) || Number.isNaN(Date.parse(schedule.dueAt))) {
    fail(['dueAt must be a UTC ISO instant']);
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone }).format(); } catch {
    fail(['timeZone must be a valid IANA timezone']);
  }
  if (schedule.durationMinutes !== undefined && (
    !Number.isInteger(schedule.durationMinutes)
    || Number(schedule.durationMinutes) < 5
    || Number(schedule.durationMinutes) > 1440
  )) fail(['durationMinutes must be an integer between 5 and 1440']);
  if (schedule.remindAt !== undefined) {
    if (
      typeof schedule.remindAt !== 'string'
      || !UTC_ISO_PATTERN.test(schedule.remindAt)
      || Number.isNaN(Date.parse(schedule.remindAt))
    ) fail(['remindAt must be a UTC ISO instant']);
    if (Date.parse(schedule.remindAt) > Date.parse(schedule.dueAt)) {
      fail(['remindAt must be earlier than or equal to dueAt']);
    }
  }
}

function validateDelegation(body: Record<string, unknown>) {
  exactFields(body, ['delegation'], 'Unexpected delegation request field');
  if (!Object.prototype.hasOwnProperty.call(body, 'delegation')) fail(['delegation is required']);
  if (body.delegation === null) return;
  if (!body.delegation || typeof body.delegation !== 'object' || Array.isArray(body.delegation)) {
    fail(['delegation must be an object or null']);
  }
  const delegation = body.delegation as Record<string, unknown>;
  exactFields(delegation, ['assigneeUserId', 'displayLabel', 'handoffNote'], 'Unexpected delegation field');
  if (
    typeof delegation.assigneeUserId !== 'string'
    || delegation.assigneeUserId.trim().length < 1
    || delegation.assigneeUserId.trim().length > 128
  ) fail(['assigneeUserId must contain 1-128 characters']);
  if (
    typeof delegation.displayLabel !== 'string'
    || delegation.displayLabel.trim().length < 1
    || delegation.displayLabel.trim().length > 120
  ) fail(['displayLabel must contain 1-120 characters']);
  if (delegation.handoffNote !== undefined && (
    typeof delegation.handoffNote !== 'string' || delegation.handoffNote.trim().length > 1000
  )) fail(['handoffNote must contain at most 1000 characters']);
}

@Injectable()
export class TaskIdPipe implements PipeTransform<string, string> {
  transform(value: string) {
    if (!/^[a-f0-9]{24}$/i.test(value)) fail(['Invalid value']);
    return value;
  }
}

@Injectable()
export class TaskValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata) {
    if (metadata.type !== 'body' || !metadata.metatype) return value;
    const body = objectBody(value);
    const type = metadata.metatype;
    if (type === ScheduleTaskDto) { validateSchedule(body); return value; }
    if (type === DelegationTaskDto) { validateDelegation(body); return value; }
    const unexpectedMessages = new Map<Function, string>([
      [CreateTaskDto, 'Unexpected task field'], [UpdateTaskDto, 'Unexpected task field'],
      [LifecycleTaskDto, 'Unexpected lifecycle field'],
      [DelegationStatusTaskDto, 'Unexpected delegation status field'],
    ]);
    const unexpected = unexpectedMessages.get(type);
    if (unexpected) {
      const declared = type === CreateTaskDto || type === UpdateTaskDto
        ? ['title', 'description', 'urgent', 'important']
        : type === LifecycleTaskDto ? ['action'] : ['status'];
      exactFields(body, declared, unexpected);
    }
    const validationBody = {
      ...body,
      ...(typeof body.title === 'string' ? { title: body.title.trim() } : {}),
      ...(typeof body.description === 'string' ? { description: body.description.trim() } : {}),
    };
    const errors = validateSync(plainToInstance(type, validationBody), {
      whitelist: true, forbidNonWhitelisted: true, stopAtFirstError: true,
    });
    if (errors.length) fail(errors.map(() => 'Invalid value'));
    return value;
  }
}
