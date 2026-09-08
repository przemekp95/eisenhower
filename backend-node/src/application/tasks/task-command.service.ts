import type { AuthPrincipal } from '../../auth';
import { createTask, IdempotencyKeyReuseError, IdempotencyResultDeletedError } from '../createTask';
import type {
  StoredTask, TaskDelegationAssignment, TaskDelegationStatus, TaskLifecycleAction,
  TaskPayload, TaskRepository, TaskSchedule,
} from '../taskRepository';
import { TaskCommandError, taskCommandError } from './task-errors';

const MONGO_ID_PATTERN = /^[a-f0-9]{24}$/i;

export interface TaskWriteResult {
  task: StoredTask;
  status: 200 | 201;
  idempotencyReplayed?: true;
}

const ownerScope = (principal: AuthPrincipal) => ({
  tenantId: principal.tenantId, ownerId: principal.userId,
});
const principalScope = (principal: AuthPrincipal) => ({
  tenantId: principal.tenantId, userId: principal.userId,
});

function ensureTaskId(id: string) {
  if (!MONGO_ID_PATTERN.test(id)) {
    throw new TaskCommandError(400, { error: 'Validation failed', details: ['Invalid value'] });
  }
}

function normalizePayload(payload: Partial<TaskPayload>, create: boolean): TaskPayload | Partial<TaskPayload> {
  return {
    ...(payload.title !== undefined ? { title: payload.title.trim() } : {}),
    ...(payload.description !== undefined ? { description: payload.description.trim() } : create ? { description: '' } : {}),
    ...(payload.urgent !== undefined ? { urgent: payload.urgent } : create ? { urgent: false } : {}),
    ...(payload.important !== undefined ? { important: payload.important } : create ? { important: false } : {}),
  };
}

export class TaskCommandService {
  constructor(private readonly repository: TaskRepository) {}

  async create(
    principal: AuthPrincipal,
    payload: TaskPayload,
    idempotencyKey?: string,
  ): Promise<TaskWriteResult> {
    try {
      const result = await createTask(
        this.repository,
        ownerScope(principal),
        normalizePayload(payload, true) as TaskPayload,
        idempotencyKey,
      );
      return {
        task: result.task,
        status: result.replayed ? 200 : 201,
        ...(result.replayed ? { idempotencyReplayed: true as const } : {}),
      };
    } catch (error) {
      if (error instanceof IdempotencyKeyReuseError) {
        throw taskCommandError(409, error.message, error.code);
      }
      if (error instanceof IdempotencyResultDeletedError) {
        throw taskCommandError(410, error.message, error.code);
      }
      throw error;
    }
  }

  async update(principal: AuthPrincipal, id: string, revision: number, patch: Partial<TaskPayload>) {
    ensureTaskId(id);
    const scope = ownerScope(principal);
    const task = await this.repository.update(scope, id, revision, normalizePayload(patch, false));
    if (task) return task;
    if (await this.repository.exists(scope, id)) {
      throw taskCommandError(412, 'Task revision conflict', 'task_revision_conflict');
    }
    throw taskCommandError(404, 'Task not found');
  }

  async transitionLifecycle(
    principal: AuthPrincipal, id: string, revision: number, action: TaskLifecycleAction,
  ) {
    ensureTaskId(id);
    const result = await this.repository.transitionLifecycle(ownerScope(principal), id, revision, action);
    if (result.status === 'updated') return result.task;
    if (result.status === 'not_found') throw taskCommandError(404, 'Task not found');
    if (result.status === 'revision_conflict') {
      throw taskCommandError(412, 'Task revision conflict', 'task_revision_conflict');
    }
    throw taskCommandError(409, 'Invalid task lifecycle transition', 'invalid_lifecycle_transition');
  }

  async updateSchedule(
    principal: AuthPrincipal, id: string, revision: number, schedule: TaskSchedule | null,
  ) {
    ensureTaskId(id);
    const scope = ownerScope(principal);
    const task = await this.repository.updateSchedule(scope, id, revision, schedule);
    if (task) return task;
    if (await this.repository.exists(scope, id)) {
      throw taskCommandError(412, 'Task revision conflict', 'task_revision_conflict');
    }
    throw taskCommandError(404, 'Task not found');
  }

  async updateDelegation(
    principal: AuthPrincipal,
    id: string,
    revision: number,
    input: TaskDelegationAssignment | null,
  ) {
    ensureTaskId(id);
    const scope = ownerScope(principal);
    const normalized = input ? {
      assigneeUserId: input.assigneeUserId.trim(),
      displayLabel: input.displayLabel.trim(),
      handoffNote: input.handoffNote?.trim() ?? '',
    } : null;
    const task = await this.repository.updateDelegation(scope, id, revision, normalized);
    if (task) return task;
    if (await this.repository.exists(scope, id)) {
      throw taskCommandError(412, 'Task revision conflict', 'task_revision_conflict');
    }
    throw taskCommandError(404, 'Task not found');
  }

  async transitionDelegation(
    principal: AuthPrincipal,
    id: string,
    revision: number,
    status: TaskDelegationStatus,
  ) {
    ensureTaskId(id);
    const result = await this.repository.transitionDelegation(
      principalScope(principal), id, revision, status,
    );
    if (result.status === 'updated') return result.task;
    if (result.status === 'not_found') throw taskCommandError(404, 'Task not found');
    if (result.status === 'revision_conflict') {
      throw taskCommandError(412, 'Task revision conflict', 'task_revision_conflict');
    }
    throw taskCommandError(
      409, 'Invalid delegation status transition', 'invalid_delegation_transition',
    );
  }

  async delete(principal: AuthPrincipal, id: string, revision: number) {
    ensureTaskId(id);
    const scope = ownerScope(principal);
    const state = await this.repository.getLifecycleState(scope, id);
    if (state === null) throw taskCommandError(404, 'Task not found');
    if (state !== 'trashed') {
      throw taskCommandError(409, 'Task must be trashed before final deletion', 'task_not_trashed');
    }
    const task = await this.repository.delete(scope, id, revision);
    if (task) return task;
    if (await this.repository.exists(scope, id)) {
      throw taskCommandError(412, 'Task revision conflict', 'task_revision_conflict');
    }
    throw taskCommandError(404, 'Task not found');
  }
}
