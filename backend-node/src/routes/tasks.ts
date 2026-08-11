import { NextFunction, Request, Response, Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import { createTask, IdempotencyKeyReuseError } from '../application/createTask';
import {
  StoredTask,
  TaskPayload,
  TaskRepository,
} from '../application/taskRepository';
import { MongooseTaskRepository } from '../repositories/mongooseTaskRepository';

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MONGO_ID_PATTERN = /^[a-f0-9]{24}$/i;

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
    response.status(400).json({ error: 'If-Match must contain a strong quoted numeric task revision' });
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
  return Buffer.from(JSON.stringify({
    createdAt: task.createdAt.toISOString(),
    id: task._id,
  } satisfies TaskCursor)).toString('base64url');
}

function decodeCursor(value: unknown): TaskCursor | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<TaskCursor>;
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

export function createTasksRouter(
  repository: TaskRepository = new MongooseTaskRepository(),
) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const requestedLimit = req.query.limit === undefined ? undefined : Number(req.query.limit);
      if (
        requestedLimit !== undefined &&
        (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_PAGE_LIMIT)
      ) {
        return res.status(400).json({ error: `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}` });
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
      );
      if (page.hasNextPage) {
        const nextCursor = encodeCursor(page.tasks[page.tasks.length - 1]);
        res.set('X-Next-Cursor', nextCursor);
        res.set('Link', `<?limit=${limit}&cursor=${encodeURIComponent(nextCursor)}>; rel="next"`);
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

  router.delete('/:id', deleteValidators, async (req: Request, res: Response, next: NextFunction) => {
    const errors = ensureValidRequest(req);
    if (errors) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    const expectedRevision = requireTaskRevision(req, res);
    if (expectedRevision === null) return;

    try {
      const scope = taskScope(req);
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
  });

  return router;
}
