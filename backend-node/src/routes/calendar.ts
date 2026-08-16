import { Request, Router } from 'express';
import { CalendarApplicationService } from '../application/calendar';
import {
  CalendarConflictModel, CalendarConnectionModel, CalendarOutboxModel, CalendarSyncStateModel,
} from '../models/calendar';
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
  canConnect = false,
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

  router.get('/conflicts', requireScope('calendar:read', onReject), async (req, res, next) => {
    try {
      return res.json(await CalendarConflictModel.find({ ...scope(req), status: 'open' }).sort({ createdAt: 1 }).lean());
    } catch (error) { return next(error); }
  });

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
