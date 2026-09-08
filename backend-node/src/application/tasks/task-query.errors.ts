export class TaskQueryError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly body: { error: string; details?: string[] },
  ) {
    super(body.error);
  }
}

export function invalidTaskIdError() {
  return new TaskQueryError(400, { error: 'Validation failed', details: ['Invalid value'] });
}

export function invalidLifecycleFilterError() {
  return new TaskQueryError(400, { error: 'Invalid lifecycle filter' });
}

export function invalidTaskLimitError() {
  return new TaskQueryError(400, { error: 'limit must be an integer from 1 to 200' });
}

export function invalidTaskCursorError() {
  return new TaskQueryError(400, { error: 'Invalid task cursor' });
}

export function taskNotFoundError() {
  return new TaskQueryError(404, { error: 'Task not found' });
}
