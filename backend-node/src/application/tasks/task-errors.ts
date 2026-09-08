export type TaskCommandStatus = 400 | 404 | 409 | 410 | 412 | 428;

export class TaskCommandError extends Error {
  constructor(
    readonly status: TaskCommandStatus,
    readonly body: { error: string; code?: string; details?: string[] },
  ) {
    super(body.error);
  }
}

export const taskCommandError = (
  status: TaskCommandStatus,
  error: string,
  code?: string,
) => new TaskCommandError(status, { error, ...(code ? { code } : {}) });
