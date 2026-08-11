import { NextFunction, Request, Response, Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { TaskModel } from '../models/task';

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;

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
  body('description').optional().isString().isLength({ max: 2000 }),
  body('urgent').optional().isBoolean(),
  body('important').optional().isBoolean(),
];

const updateValidators = [
  param('id').isMongoId(),
  rejectUnexpectedFields,
  body('title').optional().isString().trim().notEmpty().isLength({ max: 200 }),
  body('description').optional().isString().isLength({ max: 2000 }),
  body('urgent').optional().isBoolean(),
  body('important').optional().isBoolean(),
];

const deleteValidators = [param('id').isMongoId()];

function ensureValidRequest(request: Parameters<typeof validationResult>[0]) {
  const errors = validationResult(request);
  if (!errors.isEmpty()) {
    return errors.array().map((entry) => entry.msg);
  }

  return null;
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

function normalizeTaskRevision<T extends { revision?: number }>(task: T): T & { revision: number } {
  return { ...task, revision: task.revision ?? 0 };
}

function revisionFilter(expectedRevision: number | undefined) {
  if (expectedRevision === undefined) return {};
  if (expectedRevision === 0) {
    return { $or: [{ revision: 0 }, { revision: { $exists: false } }] };
  }
  return { revision: expectedRevision };
}

function parseIfMatch(request: Request): number | null | undefined {
  const value = request.get('if-match');
  if (value === undefined) return undefined;
  const match = /^(?:W\/)?"(\d+)"$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]);
}

function encodeCursor(task: { createdAt?: Date; _id: unknown }) {
  return Buffer.from(JSON.stringify({
    createdAt: task.createdAt!.toISOString(),
    id: String(task._id),
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
      !mongoose.isValidObjectId(cursor.id)
    ) {
      return null;
    }
    return cursor as TaskCursor;
  } catch {
    return null;
  }
}

export function createTasksRouter() {
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

      const scope = taskScope(req);
      const filter = cursor ? {
        ...scope,
        $or: [
          { createdAt: { $lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), _id: { $lt: cursor.id } },
        ],
      } : scope;
      const query = TaskModel.find(filter).sort({ createdAt: -1, _id: -1 });
      if (requestedLimit === undefined && cursor === undefined) {
        const tasks = await query.lean();
        return res.json(tasks.map(normalizeTaskRevision));
      }

      const limit = requestedLimit ?? DEFAULT_PAGE_LIMIT;
      const page = await query.limit(limit + 1).lean();
      const hasNextPage = page.length > limit;
      const tasks = hasNextPage ? page.slice(0, limit) : page;
      if (hasNextPage) {
        const nextCursor = encodeCursor(tasks[tasks.length - 1]);
        res.set('X-Next-Cursor', nextCursor);
        res.links({ next: `${req.baseUrl}?limit=${limit}&cursor=${encodeURIComponent(nextCursor)}` });
      }
      res.json(tasks.map(normalizeTaskRevision));
    } catch (error) {
      next(error);
    }
  });

  router.post('/', createValidators, async (req: Request, res: Response, next: NextFunction) => {
    const errors = ensureValidRequest(req);
    if (errors) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    try {
      const task = await TaskModel.create({
        tenantId: req.auth!.tenantId,
        ownerId: req.auth!.userId,
        title: req.body.title,
        description: req.body.description ?? '',
        urgent: req.body.urgent ?? false,
        important: req.body.important ?? false,
      });

      return res.status(201).set('ETag', formatRevisionEtag(task.revision)).json(task.toJSON());
    } catch (error) {
      return next(error);
    }
  });

  router.put('/:id', updateValidators, async (req: Request, res: Response, next: NextFunction) => {
    const errors = ensureValidRequest(req);
    if (errors) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    try {
      const expectedRevision = parseIfMatch(req);
      if (expectedRevision === null) {
        return res.status(400).json({ error: 'If-Match must contain a quoted numeric task revision' });
      }
      const scope = taskScope(req);
      const task = await TaskModel.findOneAndUpdate(
        {
          _id: req.params.id,
          ...scope,
          ...revisionFilter(expectedRevision),
        },
        { $set: req.body, $inc: { revision: 1 } },
        {
          returnDocument: 'after',
          runValidators: true,
        }
      );

      if (!task) {
        if (expectedRevision !== undefined && await TaskModel.exists({ _id: req.params.id, ...scope })) {
          return res.status(412).json({
            error: 'Task revision conflict',
            code: 'task_revision_conflict',
          });
        }
        return res.status(404).json({ error: 'Task not found' });
      }

      return res.set('ETag', formatRevisionEtag(task.revision)).json(task.toJSON());
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:id', deleteValidators, async (req: Request, res: Response, next: NextFunction) => {
    const errors = ensureValidRequest(req);
    if (errors) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    try {
      const expectedRevision = parseIfMatch(req);
      if (expectedRevision === null) {
        return res.status(400).json({ error: 'If-Match must contain a quoted numeric task revision' });
      }
      const scope = taskScope(req);
      const task = await TaskModel.findOneAndDelete({
        _id: req.params.id,
        ...scope,
        ...revisionFilter(expectedRevision),
      });
      if (!task) {
        if (expectedRevision !== undefined && await TaskModel.exists({ _id: req.params.id, ...scope })) {
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
