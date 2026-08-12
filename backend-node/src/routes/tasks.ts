import { NextFunction, Request, Response, Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import {
  createTask,
  IdempotencyKeyReuseError,
  IdempotencyResultDeletedError,
} from '../application/createTask';
import {
  StoredTask,
  TASK_DELEGATION_STATUSES,
  TASK_LIFECYCLE_ACTIONS,
  TASK_LIFECYCLE_STATES,
  TaskLifecycleAction,
  TaskLifecycleFilter,
  TaskDelegationAssignment,
  TaskDelegationStatus,
  TaskPayload,
  TaskRepository,
  TaskSchedule,
} from '../application/taskRepository';
import { MongooseTaskRepository } from '../repositories/mongooseTaskRepository';

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MONGO_ID_PATTERN = /^[a-f0-9]{24}$/i;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

interface TaskCursor {
  createdAt: string;
  id: string;
}

const taskFields = new Set(['title', 'description', 'urgent', 'important']);
const rejectUnexpectedFields = body().custom((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object');
  }

  if (Object.keys(value).some((field) => !taskFields.has(field))) {
    throw new Error('Unexpected task field');
  }

  return true;
});

const createValidators = [
  rejectUnexpectedFields,
  body('title').isString().trim().notEmpty().isLength({ max: 200 }),
  body('description').optional().isString().trim().isLength({ max: 2000 }),
  body('urgent').optional().isBoolean(),
  body('important').optional().isBoolean(),
];

const updateValidators = [
  param('id').isMongoId(),
  rejectUnexpectedFields,
  body('title').optional().isString().trim().notEmpty().isLength({ max: 200 }),
  body('description').optional().isString().trim().isLength({ max: 2000 }),
  body('urgent').optional().isBoolean(),
  body('important').optional().isBoolean(),
];

const deleteValidators = [param('id').isMongoId()];
const lifecycleValidators = [
  param('id').isMongoId(),
  body().custom((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Request body must be an object');
    }
    if (Object.keys(value).some((field) => field !== 'action')) {
      throw new Error('Unexpected lifecycle field');
    }
    return true;
  }),
  body('action').isIn(TASK_LIFECYCLE_ACTIONS),
];
const scheduleValidators = [
  param('id').isMongoId(),
  body().custom((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Request body must be an object');
    }
    if (Object.keys(value).some((field) => field !== 'schedule')) {
      throw new Error('Unexpected schedule request field');
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'schedule')) {
      throw new Error('schedule is required');
    }
    const schedule = value.schedule;
    if (schedule === null) return true;
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
      throw new Error('schedule must be an object or null');
    }
    const fields = new Set(['dueAt', 'timeZone', 'remindAt']);
    if (Object.keys(schedule).some((field) => !fields.has(field))) {
      throw new Error('Unexpected schedule field');
    }
    if (typeof schedule.dueAt !== 'string' || typeof schedule.timeZone !== 'string') {
      throw new Error('dueAt and timeZone are required together');
    }
    if (!UTC_ISO_PATTERN.test(schedule.dueAt) || Number.isNaN(Date.parse(schedule.dueAt))) {
      throw new Error('dueAt must be a UTC ISO instant');
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone }).format();
    } catch {
      throw new Error('timeZone must be a valid IANA timezone');
    }
    if (schedule.remindAt !== undefined) {
      if (
        typeof schedule.remindAt !== 'string' ||
        !UTC_ISO_PATTERN.test(schedule.remindAt) ||
        Number.isNaN(Date.parse(schedule.remindAt))
      ) {
        throw new Error('remindAt must be a UTC ISO instant');
      }
      if (Date.parse(schedule.remindAt) > Date.parse(schedule.dueAt)) {
        throw new Error('remindAt must be earlier than or equal to dueAt');
      }
    }
    return true;
  }),
];
const delegationValidators = [
  param('id').isMongoId(),
  body().custom((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Request body must be an object');
    }
    if (Object.keys(value).some((field) => field !== 'delegation')) {
      throw new Error('Unexpected delegation request field');
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'delegation')) {
      throw new Error('delegation is required');
    }
    const delegation = value.delegation;
    if (delegation === null) return true;
    if (!delegation || typeof delegation !== 'object' || Array.isArray(delegation)) {
      throw new Error('delegation must be an object or null');
    }
    const fields = new Set(['assigneeUserId', 'displayLabel', 'handoffNote']);
    if (Object.keys(delegation).some((field) => !fields.has(field))) {
      throw new Error('Unexpected delegation field');
    }
    if (
      typeof delegation.assigneeUserId !== 'string' ||
      delegation.assigneeUserId.trim().length < 1 ||
      delegation.assigneeUserId.trim().length > 128
    ) {
      throw new Error('assigneeUserId must contain 1-128 characters');
    }
    if (
      typeof delegation.displayLabel !== 'string' ||
      delegation.displayLabel.trim().length < 1 ||
      delegation.displayLabel.trim().length > 120
    ) {
      throw new Error('displayLabel must contain 1-120 characters');
    }
    if (
      delegation.handoffNote !== undefined &&
      (typeof delegation.handoffNote !== 'string' || delegation.handoffNote.trim().length > 1000)
    ) {
      throw new Error('handoffNote must contain at most 1000 characters');
    }
    return true;
  }),
];
const delegationStatusValidators = [
  param('id').isMongoId(),
  body().custom((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Request body must be an object');
    }
    if (Object.keys(value).some((field) => field !== 'status')) {
      throw new Error('Unexpected delegation status field');
    }
    return true;
  }),
  body('status').isIn(TASK_DELEGATION_STATUSES),
];

function ensureValidRequest(request: Parameters<typeof validationResult>[0]) {
  const errors = validationResult(request);
  return errors.isEmpty() ? null : errors.array().map((entry) => entry.msg);
}

function taskScope(request: Request) {
  return {
    tenantId: request.auth!.tenantId,
    ownerId: request.auth!.userId,
  };
}

function principalScope(request: Request) {
  return {
    tenantId: request.auth!.tenantId,
    userId: request.auth!.userId,
  };
}

function formatRevisionEtag(revision: number) {
  return `"${revision}"`;
}

function parseIfMatch(request: Request): number | null | undefined {
  const value = request.get('if-match');
  if (value === undefined) return undefined;
  const match = /^"(\d+)"$/.exec(value.trim());
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : null;
}

function requireTaskRevision(request: Request, response: Response) {
  const revision = parseIfMatch(request);
  if (revision === undefined) {
    response.status(428).json({
      error: 'If-Match is required for task mutations',
      code: 'precondition_required',
    });
    return null;
  }
  if (revision === null) {
    response
      .status(400)
      .json({ error: 'If-Match must contain a strong quoted numeric task revision' });
    return null;
  }
  return revision;
}

function readIdempotencyKey(request: Request, response: Response) {
  const value = request.get('idempotency-key');
  if (value === undefined) return undefined;
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    response.status(400).json({ error: 'Idempotency-Key must contain 1-128 URL-safe characters' });
    return null;
  }
  return value;
}

function encodeCursor(task: Pick<StoredTask, 'createdAt' | '_id'>) {
  return Buffer.from(
    JSON.stringify({
      createdAt: task.createdAt.toISOString(),
      id: task._id,
    } satisfies TaskCursor)
  ).toString('base64url');
}

function decodeCursor(value: unknown): TaskCursor | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8')
    ) as Partial<TaskCursor>;
    if (
      typeof cursor.createdAt !== 'string' ||
      Number.isNaN(Date.parse(cursor.createdAt)) ||
      typeof cursor.id !== 'string' ||
      !MONGO_ID_PATTERN.test(cursor.id)
    ) {
      return null;
    }
    return cursor as TaskCursor;
  } catch {
    return null;
  }
}

export function createTasksRouter(repository: TaskRepository = new MongooseTaskRepository()) {
  const router = Router();

  router.get('/delegated', async (req, res, next) => {
    try {
      const tasks = await repository.listDelegated(principalScope(req), MAX_PAGE_LIMIT);
      return res.json(tasks);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', param('id').isMongoId(), async (req: Request, res: Response, next: NextFunction) => {
    const errors = ensureValidRequest(req);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    try {
      const task = await repository.get(taskScope(req), req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      return res.set('ETag', formatRevisionEtag(task.revision)).json(task);
    } catch (error) { return next(error); }
  });

  router.get('/', async (req, res, next) => {
    try {
      const lifecycleValue = req.query.lifecycle ?? 'active';
      if (
        typeof lifecycleValue !== 'string' ||
        (lifecycleValue !== 'all' && !TASK_LIFECYCLE_STATES.includes(lifecycleValue as never))
      ) {
        return res.status(400).json({ error: 'Invalid lifecycle filter' });
      }
      const lifecycle = lifecycleValue as TaskLifecycleFilter;
      const requestedLimit = req.query.limit === undefined ? undefined : Number(req.query.limit);
      if (
        requestedLimit !== undefined &&
        (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_PAGE_LIMIT)
      ) {
        return res
          .status(400)
          .json({ error: `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}` });
      }
      const cursor = req.query.cursor === undefined ? undefined : decodeCursor(req.query.cursor);
      if (req.query.cursor !== undefined && !cursor) {
        return res.status(400).json({ error: 'Invalid task cursor' });
      }

      const limit = requestedLimit ?? DEFAULT_PAGE_LIMIT;
      const page = await repository.listPage(
        taskScope(req),
        limit,
        cursor ? { createdAt: new Date(cursor.createdAt), id: cursor.id } : undefined,
        lifecycle
      );
      if (page.hasNextPage) {
        const nextCursor = encodeCursor(page.tasks[page.tasks.length - 1]);
        res.set('X-Next-Cursor', nextCursor);
        const lifecycleQuery = lifecycle === 'active' ? '' : `&lifecycle=${lifecycle}`;
        res.set(
          'Link',
          `<?limit=${limit}${lifecycleQuery}&cursor=${encodeURIComponent(nextCursor)}>; rel="next"`
        );
      }
      return res.json(page.tasks);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', createValidators, async (req: Request, res: Response, next: NextFunction) => {
    const errors = ensureValidRequest(req);
    if (errors) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    const clientOperationId = readIdempotencyKey(req, res);
    if (clientOperationId === null) return;

    const payload: TaskPayload = {
      title: req.body.title,
      description: req.body.description ?? '',
      urgent: req.body.urgent ?? false,
      important: req.body.important ?? false,
    };

    try {
      const result = await createTask(repository, taskScope(req), payload, clientOperationId);
      if (result.replayed) res.set('Idempotency-Replayed', 'true');
      return res
        .status(result.replayed ? 200 : 201)
        .set('ETag', formatRevisionEtag(result.task.revision))
        .json(result.task);
    } catch (error) {
      if (error instanceof IdempotencyKeyReuseError) {
        return res.status(409).json({ error: error.message, code: error.code });
      }
      if (error instanceof IdempotencyResultDeletedError) {
        return res.status(410).json({ error: error.message, code: error.code });
      }
      return next(error);
    }
  });

  router.put('/:id', updateValidators, async (req: Request, res: Response, next: NextFunction) => {
    const errors = ensureValidRequest(req);
    if (errors) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    const expectedRevision = requireTaskRevision(req, res);
    if (expectedRevision === null) return;

    try {
      const scope = taskScope(req);
      const task = await repository.update(scope, req.params.id, expectedRevision, req.body);
      if (!task) {
        if (await repository.exists(scope, req.params.id)) {
          return res.status(412).json({
            error: 'Task revision conflict',
            code: 'task_revision_conflict',
          });
        }
        return res.status(404).json({ error: 'Task not found' });
      }

      return res.set('ETag', formatRevisionEtag(task.revision)).json(task);
    } catch (error) {
      return next(error);
    }
  });

  router.put(
    '/:id/lifecycle',
    lifecycleValidators,
    async (req: Request, res: Response, next: NextFunction) => {
      const errors = ensureValidRequest(req);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const expectedRevision = requireTaskRevision(req, res);
      if (expectedRevision === null) return;

      try {
        const result = await repository.transitionLifecycle(
          taskScope(req),
          req.params.id,
          expectedRevision,
          req.body.action as TaskLifecycleAction
        );
        if (result.status === 'not_found') return res.status(404).json({ error: 'Task not found' });
        if (result.status === 'revision_conflict') {
          return res.status(412).json({
            error: 'Task revision conflict',
            code: 'task_revision_conflict',
          });
        }
        if (result.status === 'invalid_transition') {
          return res.status(409).json({
            error: 'Invalid task lifecycle transition',
            code: 'invalid_lifecycle_transition',
          });
        }
        return res.set('ETag', formatRevisionEtag(result.task.revision)).json(result.task);
      } catch (error) {
        return next(error);
      }
    }
  );

  router.put(
    '/:id/schedule',
    scheduleValidators,
    async (req: Request, res: Response, next: NextFunction) => {
      const errors = ensureValidRequest(req);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const expectedRevision = requireTaskRevision(req, res);
      if (expectedRevision === null) return;

      const schedule: TaskSchedule | null =
        req.body.schedule === null
          ? null
          : {
              dueAt: new Date(req.body.schedule.dueAt),
              timeZone: req.body.schedule.timeZone,
              ...(req.body.schedule.remindAt
                ? { remindAt: new Date(req.body.schedule.remindAt) }
                : {}),
            };
      try {
        const scope = taskScope(req);
        const task = await repository.updateSchedule(
          scope,
          req.params.id,
          expectedRevision,
          schedule
        );
        if (!task) {
          if (await repository.exists(scope, req.params.id)) {
            return res.status(412).json({
              error: 'Task revision conflict',
              code: 'task_revision_conflict',
            });
          }
          return res.status(404).json({ error: 'Task not found' });
        }
        return res.set('ETag', formatRevisionEtag(task.revision)).json(task);
      } catch (error) {
        return next(error);
      }
    }
  );

  router.put(
    '/:id/delegation',
    delegationValidators,
    async (req: Request, res: Response, next: NextFunction) => {
      const errors = ensureValidRequest(req);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const expectedRevision = requireTaskRevision(req, res);
      if (expectedRevision === null) return;

      const delegation: TaskDelegationAssignment | null = req.body.delegation === null
        ? null
        : {
          assigneeUserId: req.body.delegation.assigneeUserId.trim(),
          displayLabel: req.body.delegation.displayLabel.trim(),
          handoffNote: req.body.delegation.handoffNote?.trim() ?? '',
        };
      try {
        const scope = taskScope(req);
        const task = await repository.updateDelegation(
          scope,
          req.params.id,
          expectedRevision,
          delegation
        );
        if (!task) {
          if (await repository.exists(scope, req.params.id)) {
            return res.status(412).json({
              error: 'Task revision conflict',
              code: 'task_revision_conflict',
            });
          }
          return res.status(404).json({ error: 'Task not found' });
        }
        return res.set('ETag', formatRevisionEtag(task.revision)).json(task);
      } catch (error) {
        return next(error);
      }
    }
  );

  router.put(
    '/:id/delegation/status',
    delegationStatusValidators,
    async (req: Request, res: Response, next: NextFunction) => {
      const errors = ensureValidRequest(req);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const expectedRevision = requireTaskRevision(req, res);
      if (expectedRevision === null) return;

      try {
        const result = await repository.transitionDelegation(
          principalScope(req),
          req.params.id,
          expectedRevision,
          req.body.status as TaskDelegationStatus
        );
        if (result.status === 'not_found') return res.status(404).json({ error: 'Task not found' });
        if (result.status === 'revision_conflict') {
          return res.status(412).json({
            error: 'Task revision conflict',
            code: 'task_revision_conflict',
          });
        }
        if (result.status === 'invalid_transition') {
          return res.status(409).json({
            error: 'Invalid delegation status transition',
            code: 'invalid_delegation_transition',
          });
        }
        return res.set('ETag', formatRevisionEtag(result.task.revision)).json(result.task);
      } catch (error) {
        return next(error);
      }
    }
  );

  router.delete(
    '/:id',
    deleteValidators,
    async (req: Request, res: Response, next: NextFunction) => {
      const errors = ensureValidRequest(req);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const expectedRevision = requireTaskRevision(req, res);
      if (expectedRevision === null) return;

      try {
        const scope = taskScope(req);
        const lifecycleState = await repository.getLifecycleState(scope, req.params.id);
        if (lifecycleState === null) return res.status(404).json({ error: 'Task not found' });
        if (lifecycleState !== 'trashed') {
          return res.status(409).json({
            error: 'Task must be trashed before final deletion',
            code: 'task_not_trashed',
          });
        }
        const task = await repository.delete(scope, req.params.id, expectedRevision);
        if (!task) {
          if (await repository.exists(scope, req.params.id)) {
            return res.status(412).json({
              error: 'Task revision conflict',
              code: 'task_revision_conflict',
            });
          }
          return res.status(404).json({ error: 'Task not found' });
        }

        return res.status(204).send();
      } catch (error) {
        return next(error);
      }
    }
  );

  return router;
}
