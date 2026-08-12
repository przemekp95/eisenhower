import { Request, Router } from 'express';
import { CalendarApplicationService } from '../application/calendar';
import {
  CalendarBindingModel,
  CalendarConflictModel,
  CalendarConnectionModel,
  CalendarDomainAuditModel,
  CalendarOutboxModel,
  CalendarSyncStateModel,
} from '../models/calendar';
import { TaskModel } from '../models/task';
import { requireScope, SecurityRejectionHandler } from '../auth';

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
) {
  const router = Router();

  router.get('/status', requireScope('calendar:read', onReject), async (req, res, next) => {
    try {
      const connection = await CalendarConnectionModel.findOne({ ...scope(req), status: 'active' }).lean();
      if (!connection) return res.json({ status: 'disconnected', connection: null });
      const [syncState, openConflicts, pendingOutbox] = await Promise.all([
        CalendarSyncStateModel.findOne({ ...scope(req), connectionId: connection._id }).lean(),
        CalendarConflictModel.countDocuments({ ...scope(req), connectionId: connection._id, status: 'open' }),
        CalendarOutboxModel.countDocuments({ ...scope(req), status: { $in: ['pending', 'leased'] } }),
      ]);
      return res.json({
        status: syncState?.fullResyncRequired ? 'pending' : 'connected',
        connection: { id: connection._id, provider: connection.provider, calendarId: connection.calendarId },
        syncState, openConflicts, pendingOutbox,
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

  router.get('/conflicts', requireScope('calendar:read', onReject), async (req, res, next) => {
    try {
      return res.json(await CalendarConflictModel.find({ ...scope(req), status: 'open' }).sort({ createdAt: 1 }).lean());
    } catch (error) { return next(error); }
  });

  router.post('/conflicts/:id/resolve', requireScope('calendar:write', onReject), async (req, res, next) => {
    const expectedRevision = revision(req);
    if (expectedRevision === null) return res.status(428).json({ error: 'If-Match is required' });
    if (!['eisenhower', 'google'].includes(req.body?.strategy)) {
      return res.status(400).json({ error: 'strategy must be eisenhower or google' });
    }
    try {
      const conflict = await CalendarConflictModel.findOne({ _id: req.params.id, ...scope(req), status: 'open' });
      if (!conflict) return res.status(404).json({ error: 'Calendar conflict not found' });
      if ((conflict.get('revision') ?? 0) !== expectedRevision) {
        return res.status(412).json({ error: 'Calendar conflict revision conflict' });
      }
      const binding = await CalendarBindingModel.findById(conflict.bindingId);
      const task = await TaskModel.findOne({ _id: conflict.taskId, ...scope(req) });
      if (!binding || !task) return res.status(409).json({ error: 'Conflict target is unavailable' });
      if (req.body.strategy === 'google') {
        const snapshot = conflict.providerSnapshot as { title: string; dueAt: string; timeZone: string };
        task.title = snapshot.title;
        task.schedule = { dueAt: new Date(snapshot.dueAt), timeZone: snapshot.timeZone };
        await task.save();
        binding.lastTaskRevision = task.revision ?? 0;
        binding.lastProviderRevision = conflict.providerRevision;
        binding.providerEtag = conflict.providerRevision;
        await binding.save();
      } else {
        await CalendarOutboxModel.create({
          eventId: `conflict:${conflict.id}:${expectedRevision}`, ...scope(req),
          aggregateId: task.id, aggregateRevision: task.revision ?? 0,
          type: 'calendar.conflict.resolved_local', payload: { bindingId: binding.id }, status: 'pending',
        });
      }
      conflict.status = req.body.strategy === 'google' ? 'resolved_provider' : 'resolved_local';
      conflict.resolvedAt = new Date();
      conflict.set('revision', expectedRevision + 1);
      await conflict.save();
      await CalendarDomainAuditModel.create({
        eventId: `resolve:${conflict.id}:${expectedRevision}`, ...scope(req), actorId: req.auth!.userId,
        action: 'calendar.conflict.resolve', outcome: 'success', resourceId: conflict.id,
        beforeRevision: expectedRevision, afterRevision: expectedRevision + 1,
      });
      return res.set('ETag', `"${expectedRevision + 1}"`).json(conflict);
    } catch (error) { return next(error); }
  });

  return router;
}
