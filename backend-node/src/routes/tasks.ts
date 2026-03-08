import { NextFunction, Request, Response, Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import { TaskModel } from '../models/task';

const createValidators = [
  body('title').isString().trim().notEmpty().isLength({ max: 200 }),
  body('description').optional().isString().isLength({ max: 2000 }),
  body('urgent').optional().isBoolean(),
  body('important').optional().isBoolean(),
];

const updateValidators = [
  param('id').isMongoId(),
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

export function createTasksRouter() {
  const router = Router();

  router.get('/', async (_req, res, next) => {
    try {
      const tasks = await TaskModel.find().sort({ createdAt: -1, _id: -1 }).lean();
      res.json(tasks);
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
        title: req.body.title,
        description: req.body.description ?? '',
        urgent: req.body.urgent ?? false,
        important: req.body.important ?? false,
      });

      return res.status(201).json(task.toJSON());
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
      const task = await TaskModel.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      });

      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      return res.json(task.toJSON());
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
      const task = await TaskModel.findByIdAndDelete(req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      return res.status(204).send();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
