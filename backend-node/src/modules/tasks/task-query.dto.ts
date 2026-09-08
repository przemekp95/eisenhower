import {
  DEFAULT_TASK_PAGE_LIMIT, MAX_TASK_PAGE_LIMIT, TaskListQuery,
} from '../../application/tasks/task-query.service';
import type { TaskLifecycleFilter } from '../../application/taskRepository';
import {
  invalidLifecycleFilterError, invalidTaskCursorError, invalidTaskLimitError,
} from '../../application/tasks/task-query.errors';
import { TASK_LIFECYCLE_STATES } from '../../application/taskRepository';

function singleton(parameters: URLSearchParams, name: string) {
  const values = parameters.getAll(name);
  if (values.length > 1) {
    if (name === 'cursor') throw invalidTaskCursorError();
    if (name === 'limit') throw invalidTaskLimitError();
    throw invalidLifecycleFilterError();
  }
  return values[0];
}

function lifecycle(value: string | undefined): TaskLifecycleFilter {
  const selected = value ?? 'active';
  if (selected !== 'all' && !TASK_LIFECYCLE_STATES.includes(selected as never)) {
    throw invalidLifecycleFilterError();
  }
  return selected as TaskLifecycleFilter;
}

export function parseTaskListQuery(rawUrl: string): TaskListQuery {
  const parameters = new URL(rawUrl, 'http://eisenhower.local').searchParams;
  const rawLimit = singleton(parameters, 'limit');
  const limit = rawLimit === undefined ? DEFAULT_TASK_PAGE_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASK_PAGE_LIMIT) {
    throw invalidTaskLimitError();
  }
  return {
    limit,
    lifecycle: lifecycle(singleton(parameters, 'lifecycle')),
    ...(parameters.has('cursor') ? { cursor: singleton(parameters, 'cursor') ?? '' } : {}),
  };
}

export function parseDelegatedTaskQuery(rawUrl: string): Pick<TaskListQuery, 'limit' | 'lifecycle'> {
  const parameters = new URL(rawUrl, 'http://eisenhower.local').searchParams;
  return {
    limit: MAX_TASK_PAGE_LIMIT,
    lifecycle: lifecycle(singleton(parameters, 'lifecycle')),
  };
}
