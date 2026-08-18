import { Request, Router } from 'express';
import { CalendarApplicationService } from '../application/calendar';
import {
  CalendarBindingModel,
  CalendarConflictModel,
  CalendarConnectionModel,
  CalendarOutboxModel,
  CalendarSyncStateModel,
} from '../models/calendar';
import { requireScope, SecurityRejectionHandler } from '../auth';
import { TaskModel } from '../models/task';
import { GoogleCalendarService } from '../application/googleCalendar';

function scope(request: Request) {
  return { tenantId: request.auth!.tenantId, ownerId: request.auth!.userId };
}

function revision(request: Request) {
  const match = /^"(\d+)"$/.exec(request.get('if-match') ?? '');
  return match ? Number(match[1]) : null;
}

export function createCalendarRouter(
  onReject?: SecurityRejectionHandler,
  service = new CalendarApplicationService(),
  canConnect = false,
  provider?: GoogleCalendarService,
) {
  const router = Router();

  router.get('/status', requireScope('calendar:read', onReject), async (req, res, next) => {
    try {
      const connection = await CalendarConnectionModel.findOne({ ...scope(req), status: 'active' }).lean();
      if (!connection) return res.json({ status: 'disconnected', connection: null, canConnect });
      const [syncState, openConflicts, pendingOutbox, failedSyncCount] = await Promise.all([
        CalendarSyncStateModel.findOne({ ...scope(req), connectionId: connection._id }).lean(),
        CalendarConflictModel.countDocuments({ ...scope(req), connectionId: connection._id, status: 'open' }),
        CalendarOutboxModel.countDocuments({ ...scope(req), status: { $in: ['pending', 'leased'] } }),
        CalendarOutboxModel.countDocuments({ ...scope(req), status: 'dead_letter' }),
      ]);
      return res.json({
        status: syncState?.fullResyncRequired ? 'pending' : 'connected',
        canConnect,
        connection: { id: connection._id, provider: connection.provider, calendarId: connection.calendarId },
        syncState: syncState ? {
          fullResyncRequired: syncState.fullResyncRequired,
          lastRequestedAt: syncState.lastRequestedAt,
          lastCompletedAt: syncState.lastCompletedAt,
        } : null,
        openConflicts, pendingOutbox, failedSyncCount, syncProblem: failedSyncCount > 0,
      });
    } catch (error) { return next(error); }
  });

  router.post('/sync-requests', requireScope('calendar:write', onReject), async (req, res, next) => {
    try {
      const operationId = req.get('idempotency-key');
      if (!operationId) return res.status(428).json({ error: 'Idempotency-Key is required' });
      const connection = await CalendarConnectionModel.findOne({ ...scope(req), status: 'active' });
      if (!connection) return res.status(409).json({ error: 'Calendar is disconnected' });
      return res.status(202).json(await service.requestSync(scope(req), connection.id, operationId));
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_operation_reused') {
        return res.status(409).json({ error: error.message });
      }
      return next(error);
    }
  });

  router.get('/events', requireScope('calendar:read', onReject), async (req, res, next) => {
    if (!provider) return res.status(404).json({ error: 'Calendar provider is unavailable' });
    const timeMin = typeof req.query.timeMin === 'string' ? req.query.timeMin : '';
    const timeMax = typeof req.query.timeMax === 'string' ? req.query.timeMax : '';
    const pageToken = typeof req.query.pageToken === 'string' ? req.query.pageToken : undefined;
    const min = Date.parse(timeMin);
    const max = Date.parse(timeMax);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || max - min > 180 * 86_400_000) {
      return res.status(400).json({ error: 'A valid event window of at most 180 days is required' });
    }
    try {
      const connection = await CalendarConnectionModel.findOne({ ...scope(req), status: 'active' });
      if (!connection) return res.status(409).json({ error: 'Calendar is disconnected' });
      return res.json(await provider.candidateEvents(connection.id, { timeMin, timeMax, ...(pageToken ? { pageToken } : {}) }));
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_connection_unavailable') {
        return res.status(409).json({ error: 'Calendar is disconnected' });
      }
      return next(error);
    }
  });

  router.post('/bindings/preview', requireScope('calendar:read', onReject), async (req, res, next) => {
    if (!provider) return res.status(404).json({ error: 'Calendar provider is unavailable' });
    if (typeof req.body?.taskId !== 'string' || typeof req.body?.providerEventId !== 'string') {
      return res.status(400).json({ error: 'taskId and providerEventId are required' });
    }
    try {
      return res.json(await provider.previewLink(scope(req), req.body.taskId, req.body.providerEventId));
    } catch (error) {
      if (error instanceof Error && ['calendar_link_target_unavailable', 'calendar_link_not_unique'].includes(error.message)) {
        return res.status(409).json({ error: error.message });
      }
      return next(error);
    }
  });

  router.post('/bindings', requireScope('calendar:write', onReject), async (req, res, next) => {
    if (!provider) return res.status(404).json({ error: 'Calendar provider is unavailable' });
    const expectedTaskRevision = revision(req);
    const operationId = req.get('idempotency-key');
    if (expectedTaskRevision === null || !operationId) {
      return res.status(428).json({ error: 'If-Match and Idempotency-Key are required' });
    }
    if (
      typeof req.body?.taskId !== 'string' ||
      typeof req.body?.providerEventId !== 'string' ||
      typeof req.body?.providerEtag !== 'string' ||
      !['google_to_eisenhower', 'eisenhower_to_google'].includes(req.body?.direction)
    ) return res.status(400).json({ error: 'Invalid calendar binding command' });
    try {
      return res.status(201).json(await provider.linkExisting({
        ...scope(req), actorId: req.auth!.userId, operationId,
        taskId: req.body.taskId, expectedTaskRevision,
        providerEventId: req.body.providerEventId, providerEtag: req.body.providerEtag,
        direction: req.body.direction,
      }));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'calendar_operation_reused') {
          return res.status(409).json({ error: error.message });
        }
        if (error.message === 'calendar_task_revision_mismatch' || error.message === 'calendar_provider_revision_mismatch') {
          return res.status(412).json({ error: error.message });
        }
        if (['calendar_link_target_unavailable', 'calendar_link_not_unique', 'calendar_link_schedule_missing'].includes(error.message)) {
          return res.status(409).json({ error: error.message });
        }
      }
      return next(error);
    }
  });

  router.post('/imports', requireScope('calendar:write', onReject), async (req, res, next) => {
    if (!provider) return res.status(404).json({ error: 'Calendar provider is unavailable' });
    const operationId = req.get('idempotency-key');
    const ids = req.body?.providerEventIds;
    if (!operationId) return res.status(428).json({ error: 'Idempotency-Key is required' });
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !id)) {
      return res.status(400).json({ error: 'Select between 1 and 20 provider events' });
    }
    try {
      return res.json(await provider.importSelected({
        ...scope(req), actorId: req.auth!.userId, operationId, providerEventIds: ids,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_connection_unavailable') {
        return res.status(409).json({ error: 'Calendar is disconnected' });
      }
      return next(error);
    }
  });

  router.get('/conflicts', requireScope('calendar:read', onReject), async (req, res, next) => {
    try {
      return res.json(await CalendarConflictModel.find({ ...scope(req), status: 'open' }).sort({ createdAt: 1 }).lean());
    } catch (error) { return next(error); }
  });

  router.get('/deleted-bindings', requireScope('calendar:read', onReject), async (req, res, next) => {
    try {
      const bindings = await CalendarBindingModel.find({
          ...scope(req),
          providerDeletedAt: { $exists: true },
        })
          .sort({ providerDeletedAt: 1 })
          .lean();
      const tasks = await TaskModel.find({
        ...scope(req),
        _id: { $in: bindings.map((binding) => binding.taskId) },
      }).lean();
      const byId = new Map(tasks.map((task) => [String(task._id), task]));
      return res.json(
        bindings.flatMap((binding) => {
          const task = byId.get(String(binding.taskId));
          return task
            ? [{
                _id: binding._id,
                taskId: binding.taskId,
                taskTitle: task.title,
                taskRevision: task.revision ?? 0,
                providerEventId: binding.providerEventId,
                providerDeletedAt: binding.providerDeletedAt,
              }]
            : [];
        }),
      );
    } catch (error) {
      return next(error);
    }
  });

  router.post(
    '/deleted-bindings/:id/resolve',
    requireScope('calendar:write', onReject),
    async (req, res, next) => {
      const expectedTaskRevision = revision(req);
      if (expectedTaskRevision === null) {
        return res.status(428).json({ error: 'If-Match is required' });
      }
      const operationId = req.get('idempotency-key');
      if (!operationId) return res.status(428).json({ error: 'Idempotency-Key is required' });
      if (!['clear_date', 'recreate', 'detach'].includes(req.body?.strategy)) {
        return res
          .status(400)
          .json({ error: 'strategy must be clear_date, recreate or detach' });
      }
      try {
        return res.json(
          await service.resolveProviderDeletion({
            ...scope(req),
            operationId,
            actorId: req.auth!.userId,
            bindingId: req.params.id,
            expectedTaskRevision,
            strategy: req.body.strategy,
          }),
        );
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === 'calendar_deleted_binding_not_found') {
            return res.status(404).json({ error: 'Deleted calendar binding not found' });
          }
          if (error.message === 'calendar_task_revision_mismatch') {
            return res.status(412).json({ error: 'Task revision conflict' });
          }
          if (
            error.message === 'calendar_conflict_target_unavailable' ||
            error.message === 'calendar_recreate_schedule_missing'
          ) {
            return res.status(409).json({ error: 'Calendar deletion target is unavailable' });
          }
          if (error.message === 'calendar_operation_reused') {
            return res.status(409).json({ error: error.message });
          }
        }
        return next(error);
      }
    },
  );

  router.post('/conflicts/:id/resolve', requireScope('calendar:write', onReject), async (req, res, next) => {
    const expectedRevision = revision(req);
    if (expectedRevision === null) return res.status(428).json({ error: 'If-Match is required' });
    const operationId = req.get('idempotency-key');
    if (!operationId) return res.status(428).json({ error: 'Idempotency-Key is required' });
    if (!['eisenhower', 'google'].includes(req.body?.strategy)) {
      return res.status(400).json({ error: 'strategy must be eisenhower or google' });
    }
    try {
      const result = await service.resolveConflict({
        ...scope(req), operationId, actorId: req.auth!.userId,
        conflictId: req.params.id, expectedRevision,
        strategy: req.body.strategy as 'eisenhower' | 'google',
      });
      return res.set('ETag', `"${result.revision}"`).json(result.conflict);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'calendar_conflict_not_found') {
          return res.status(404).json({ error: 'Calendar conflict not found' });
        }
        if (error.message === 'calendar_conflict_revision_mismatch') {
          return res.status(412).json({ error: 'Calendar conflict revision conflict' });
        }
        if (error.message === 'calendar_conflict_target_unavailable') {
          return res.status(409).json({ error: 'Conflict target is unavailable' });
        }
        if (error.message === 'calendar_operation_reused') {
          return res.status(409).json({ error: error.message });
        }
      }
      return next(error);
    }
  });

  return router;
}
