import type { AuthPrincipal } from '../../auth';
import {
  StoredTask, TASK_LIFECYCLE_STATES, TaskLifecycleFilter, TaskRepository,
} from '../taskRepository';
import {
  invalidLifecycleFilterError, invalidTaskCursorError, invalidTaskIdError,
  invalidTaskLimitError, taskNotFoundError,
} from './task-query.errors';

const MONGO_ID_PATTERN = /^[a-f0-9]{24}$/i;
export const DEFAULT_TASK_PAGE_LIMIT = 100;
export const MAX_TASK_PAGE_LIMIT = 200;

interface TaskCursor {
  createdAt: string;
  id: string;
}

export interface TaskListQuery {
  limit: number;
  cursor?: string;
  lifecycle: TaskLifecycleFilter;
}

export interface TaskListResult {
  tasks: StoredTask[];
  nextCursor?: string;
}

function ownerScope(principal: AuthPrincipal) {
  return { tenantId: principal.tenantId, ownerId: principal.userId };
}

function principalScope(principal: AuthPrincipal) {
  return { tenantId: principal.tenantId, userId: principal.userId };
}

function validateLifecycle(value: unknown): TaskLifecycleFilter {
  if (
    typeof value !== 'string'
    || (value !== 'all' && !TASK_LIFECYCLE_STATES.includes(value as never))
  ) throw invalidLifecycleFilterError();
  return value as TaskLifecycleFilter;
}

function decodeCursor(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!value) throw invalidTaskCursorError();
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<TaskCursor>;
    if (
      typeof cursor.createdAt !== 'string'
      || Number.isNaN(Date.parse(cursor.createdAt))
      || typeof cursor.id !== 'string'
      || !MONGO_ID_PATTERN.test(cursor.id)
    ) throw invalidTaskCursorError();
    return { createdAt: new Date(cursor.createdAt), id: cursor.id };
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid task cursor') throw error;
    throw invalidTaskCursorError();
  }
}

function encodeCursor(task: Pick<StoredTask, 'createdAt' | '_id'>) {
  return Buffer.from(JSON.stringify({
    createdAt: task.createdAt.toISOString(), id: task._id,
  } satisfies TaskCursor)).toString('base64url');
}

export class TaskQueryService {
  constructor(private readonly repository: TaskRepository) {}

  async getOwned(principal: AuthPrincipal, id: string) {
    if (!MONGO_ID_PATTERN.test(id)) throw invalidTaskIdError();
    const task = await this.repository.get(ownerScope(principal), id);
    if (!task) throw taskNotFoundError();
    return task;
  }

  async listOwned(principal: AuthPrincipal, query: TaskListQuery): Promise<TaskListResult> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_TASK_PAGE_LIMIT) {
      throw invalidTaskLimitError();
    }
    const lifecycle = validateLifecycle(query.lifecycle);
    const page = await this.repository.listPage(
      ownerScope(principal), query.limit, decodeCursor(query.cursor), lifecycle,
    );
    return {
      tasks: page.tasks,
      ...(page.hasNextPage ? { nextCursor: encodeCursor(page.tasks[page.tasks.length - 1]) } : {}),
    };
  }

  async listDelegated(
    principal: AuthPrincipal,
    query: Pick<TaskListQuery, 'limit' | 'lifecycle'>,
  ) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_TASK_PAGE_LIMIT) {
      throw invalidTaskLimitError();
    }
    return this.repository.listDelegated(
      principalScope(principal), query.limit, validateLifecycle(query.lifecycle),
    );
  }
}
