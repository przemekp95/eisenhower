import { NextFunction, Request, Response, Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import {
  TASK_DELEGATION_STATUSES,
  TASK_LIFECYCLE_ACTIONS,
  TaskLifecycleAction,
  TaskDelegationAssignment,
  TaskDelegationStatus,
  TaskPayload,
  TaskRepository,
  TaskSchedule,
} from '../application/taskRepository';
import { MongooseTaskRepository } from '../repositories/mongooseTaskRepository';
import { TaskQueryError } from '../application/tasks/task-query.errors';
import { TaskQueryService } from '../application/tasks/task-query.service';
import { parseDelegatedTaskQuery, parseTaskListQuery } from '../modules/tasks/task-query.dto';
import { TaskCommandService } from '../application/tasks/task-command.service';
import { TaskCommandError } from '../application/tasks/task-errors';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

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
    const fields = new Set(['dueAt', 'timeZone', 'remindAt', 'durationMinutes']);
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
    if (
      schedule.durationMinutes !== undefined &&
      (!Number.isInteger(schedule.durationMinutes) ||
        schedule.durationMinutes < 5 ||
        schedule.durationMinutes > 1440)
    ) {
      throw new Error('durationMinutes must be an integer between 5 and 1440');
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

export function createTasksRouter(repository: TaskRepository = new MongooseTaskRepository()) {
  const router = Router();
  const queries = new TaskQueryService(repository);
  const commands = new TaskCommandService(repository);

  const queryError = (error: unknown, response: Response, next: NextFunction) => {
    if (error instanceof TaskQueryError) return response.status(error.status).json(error.body);
    if (error instanceof TaskCommandError) return response.status(error.status).json(error.body);
    return next(error);
  };

  router.get('/delegated', async (req, res, next) => {
    try {
      return res.json(await queries.listDelegated(
        req.auth!, parseDelegatedTaskQuery(req.originalUrl),
      ));
    } catch (error) {
      return queryError(error, res, next);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const task = await queries.getOwned(req.auth!, req.params.id);
      return res.set('ETag', formatRevisionEtag(task.revision)).json(task);
    } catch (error) { return queryError(error, res, next); }
  });

  router.get('/', async (req, res, next) => {
    try {
      const query = parseTaskListQuery(req.originalUrl);
      const result = await queries.listOwned(req.auth!, query);
      if (result.nextCursor) {
        res.set('X-Next-Cursor', result.nextCursor);
        const lifecycleQuery = query.lifecycle === 'active' ? '' : `&lifecycle=${query.lifecycle}`;
        res.set(
          'Link',
          `<?limit=${query.limit}${lifecycleQuery}&cursor=${encodeURIComponent(result.nextCursor)}>; rel="next"`
        );
      }
      return res.json(result.tasks);
    } catch (error) {
      return queryError(error, res, next);
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
      const result = await commands.create(req.auth!, payload, clientOperationId);
      if (result.idempotencyReplayed) res.set('Idempotency-Replayed', 'true');
      return res
        .status(result.status)
        .set('ETag', formatRevisionEtag(result.task.revision))
        .json(result.task);
    } catch (error) {
      return queryError(error, res, next);
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
      const task = await commands.update(req.auth!, req.params.id, expectedRevision, req.body);
      return res.set('ETag', formatRevisionEtag(task.revision)).json(task);
    } catch (error) {
      return queryError(error, res, next);
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
        const task = await commands.transitionLifecycle(
          req.auth!, req.params.id, expectedRevision, req.body.action as TaskLifecycleAction,
        );
        return res.set('ETag', formatRevisionEtag(task.revision)).json(task);
      } catch (error) {
        return queryError(error, res, next);
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
              durationMinutes: req.body.schedule.durationMinutes ?? 30,
              ...(req.body.schedule.remindAt
                ? { remindAt: new Date(req.body.schedule.remindAt) }
                : {}),
            };
      try {
        const task = await commands.updateSchedule(req.auth!, req.params.id, expectedRevision, schedule);
        return res.set('ETag', formatRevisionEtag(task.revision)).json(task);
      } catch (error) {
        return queryError(error, res, next);
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
        const task = await commands.updateDelegation(
          req.auth!, req.params.id, expectedRevision, delegation,
        );
        return res.set('ETag', formatRevisionEtag(task.revision)).json(task);
      } catch (error) {
        return queryError(error, res, next);
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
        const task = await commands.transitionDelegation(
          req.auth!, req.params.id, expectedRevision, req.body.status as TaskDelegationStatus,
        );
        return res.set('ETag', formatRevisionEtag(task.revision)).json(task);
      } catch (error) {
        return queryError(error, res, next);
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
        await commands.delete(req.auth!, req.params.id, expectedRevision);
        return res.status(204).send();
      } catch (error) {
        return queryError(error, res, next);
      }
    }
  );

  return router;
}
