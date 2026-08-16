import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response, Router } from 'express';
import mongoose from 'mongoose';
import { CalendarApplicationService, CalendarInboundCommand } from '../application/calendar';
import {
  CalendarBindingModel,
  CalendarConflictModel,
  CalendarConnectionModel,
  CalendarOutboxModel,
  CalendarSyncStateModel,
} from '../models/calendar';

const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_OUTBOX_ATTEMPTS = 5;
// Covers the bounded provider pull plus every 250-command apply batch at the
// workflow's configured timeout/retry ceiling, preventing overlapping workers.
const OUTBOX_LEASE_MS = 35 * 60_000;

function validSignature(actual: string, expected: string) {
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && left.length === 32 && timingSafeEqual(left, right);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isCalendarInboundCommand(value: unknown): value is CalendarInboundCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Record<string, unknown>;
  if (![command.operationId, command.tenantId, command.ownerId, command.connectionId].every(nonEmptyString)) {
    return false;
  }
  if (command.kind === 'sync_token_gone') return true;
  if (command.kind === 'sync_checkpoint') {
    return nonEmptyString(command.nextPageToken) || nonEmptyString(command.nextSyncToken);
  }
  if (command.kind === 'event_deleted') {
    return nonEmptyString(command.providerEventId) && nonEmptyString(command.providerEtag);
  }
  if (command.kind === 'event_changed') {
    return nonEmptyString(command.providerEventId)
      && nonEmptyString(command.providerEtag)
      && typeof command.title === 'string'
      && nonEmptyString(command.dueAt)
      && !Number.isNaN(Date.parse(command.dueAt))
      && nonEmptyString(command.timeZone);
  }
  return false;
}

export function requireCalendarInternalHmac(key: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    const timestamp = request.get('x-eisenhower-timestamp') ?? '';
    const signature = request.get('x-eisenhower-signature') ?? '';
    const epoch = Number(timestamp);
    if (!Number.isInteger(epoch) || Math.abs(Date.now() / 1000 - epoch) > MAX_CLOCK_SKEW_SECONDS) {
      return response.status(401).json({ error: 'Invalid calendar dispatch timestamp' });
    }
    const rawBody = request.rawBody?.toString('utf8') ?? '';
    const expected = createHmac('sha256', key)
      .update(`v1\n${timestamp}\n${request.method}\n${request.originalUrl.split('?')[0]}\n${rawBody}`)
      .digest('hex');
    if (!/^[a-f0-9]{64}$/.test(signature) || !validSignature(signature, expected)) {
      return response.status(401).json({ error: 'Invalid calendar dispatch signature' });
    }
    return next();
  };
}

export function createCalendarInternalRouter(key: string, service = new CalendarApplicationService()) {
  const router = Router();
  router.use(requireCalendarInternalHmac(key));

  const applyInbound = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const command = req.body as CalendarInboundCommand;
      if (!isCalendarInboundCommand(command)) {
        return res.status(400).json({ error: 'Invalid calendar inbound command' });
      }
      const result = await service.applyInbound(command);
      return res.status(202).json(result);
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_operation_reused') {
        return res.status(409).json({ error: error.message });
      }
      return next(error);
    }
  };
  router.post('/inbound', applyInbound);
  router.post('/sync/apply', applyInbound);
  router.post('/sync/apply-batch', async (req, res, next) => {
    try {
      const commands = req.body?.commands;
      if (!Array.isArray(commands) || !commands.length || commands.length > 250) {
        return res.status(400).json({ error: 'Invalid calendar inbound command batch' });
      }
      const results = [];
      for (const command of commands as CalendarInboundCommand[]) {
        if (!isCalendarInboundCommand(command)) {
          return res.status(400).json({ error: 'Invalid calendar inbound command batch' });
        }
        results.push(await service.applyInbound(command));
      }
      return res.status(202).json({ results });
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_operation_reused') {
        return res.status(409).json({ error: error.message });
      }
      return next(error);
    }
  });

  router.post('/sync/reset', async (req, res, next) => {
    try {
      const { operationId, tenantId, ownerId, connectionId } = req.body ?? {};
      if (![operationId, tenantId, ownerId, connectionId].every((value) => typeof value === 'string' && value)) {
        return res.status(400).json({ error: 'Invalid calendar sync reset' });
      }
      return res.status(202).json(await service.applyInbound({
        operationId, tenantId, ownerId, connectionId, kind: 'sync_token_gone',
      }));
    } catch (error) { return next(error); }
  });

  router.post('/request', async (req, res, next) => {
    try {
      const { tenantId, ownerId, connectionId, operationId } = req.body ?? {};
      if (![tenantId, ownerId, connectionId, operationId].every((value) => typeof value === 'string' && value)) {
        return res.status(400).json({ error: 'Invalid calendar sync request' });
      }
      return res.status(202).json(await service.requestSync({ tenantId, ownerId }, connectionId, operationId));
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_operation_reused') {
        return res.status(409).json({ error: error.message });
      }
      return next(error);
    }
  });

  const claimOutbox = async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const leaseId = randomUUID();
      await CalendarOutboxModel.updateMany(
        { status: 'leased', leaseUntil: { $lte: now }, attempts: { $gte: MAX_OUTBOX_ATTEMPTS } },
        { $set: { status: 'dead_letter', lastError: 'calendar_dispatch_attempts_exhausted' }, $unset: { leaseId: 1, leaseUntil: 1 } },
      );
      const event = await CalendarOutboxModel.findOneAndUpdate(
        {
          attempts: { $lt: MAX_OUTBOX_ATTEMPTS },
          $or: [
            { status: 'pending', availableAt: { $lte: now } },
            { status: 'leased', leaseUntil: { $lte: now } },
          ],
        },
        { $set: { status: 'leased', leaseId, leaseUntil: new Date(now.getTime() + OUTBOX_LEASE_MS) }, $inc: { attempts: 1 } },
        { sort: { availableAt: 1 }, returnDocument: 'after' },
      ).lean();
      if (!event) return res.status(204).send();
      const connection = await CalendarConnectionModel.findOne({
        tenantId: event.tenantId, ownerId: event.ownerId, status: 'active',
      }).lean();
      const binding = await CalendarBindingModel.findOne({
        tenantId: event.tenantId, ownerId: event.ownerId, taskId: event.aggregateId,
      }).lean();
      const syncState = event.type === 'calendar.sync.requested'
        ? await CalendarSyncStateModel.findOne({
            tenantId: event.tenantId, ownerId: event.ownerId, connectionId: connection?._id,
          }).lean()
        : null;
      if (!connection || (['event_update', 'event_delete'].includes(event.type) && !binding)) {
        await CalendarOutboxModel.updateOne(
          { _id: event._id },
          { $set: { status: 'dead_letter', lastError: connection ? 'calendar_binding_missing' : 'calendar_connection_missing' }, $unset: { leaseId: 1, leaseUntil: 1 } },
        );
        return res.status(409).json({ error: 'Calendar dispatch target is unavailable' });
      }
      return res.json({
        eventId: event.eventId,
        leaseId: event.leaseId,
        type: event.type,
        tenantId: event.tenantId,
        ownerId: event.ownerId,
        aggregateId: event.aggregateId,
        aggregateRevision: event.aggregateRevision,
        payload: event.payload,
        ...(event.type === 'calendar.sync.requested'
          ? { checkpoint: syncState?.pageToken ?? syncState?.syncToken ?? 'full-resync' }
          : {}),
        provider: {
          connectionId: String(connection._id),
          calendarId: connection.calendarId,
          ...(binding ? {
            providerEventId: binding.providerEventId,
            providerEtag: binding.providerEtag,
          } : {}),
        },
      });
    } catch (error) { return next(error); }
  };
  router.post('/outbound/claim', claimOutbox);
  router.post('/outbox/claim', claimOutbox);

  const acknowledgeOutbox = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { eventId, leaseId, delivered, error, providerEventId, providerEtag, connectionId } = req.body ?? {};
      if (typeof eventId !== 'string' || !eventId || typeof delivered !== 'boolean') {
        return res.status(400).json({ error: 'Invalid calendar outbox acknowledgement' });
      }
      const leased = await CalendarOutboxModel.findOne({ eventId, status: 'leased' }).lean();
      if (!leased) return res.status(404).json({ error: 'Outbox event not found' });
      if (leased.leaseId && leaseId !== leased.leaseId) {
        return res.status(409).json({ error: 'Outbox event lease changed' });
      }
      const exhausted = !delivered && leased.attempts >= MAX_OUTBOX_ATTEMPTS;
      let event: typeof leased | null = null;
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          event = await CalendarOutboxModel.findOneAndUpdate(
            { eventId, status: 'leased', ...(leased.leaseId ? { leaseId: leased.leaseId } : {}) },
            delivered
              ? { $set: { status: 'delivered' }, $unset: { leaseId: 1, leaseUntil: 1, lastError: 1 } }
              : exhausted
                ? { $set: { status: 'dead_letter', lastError: String(error ?? 'provider_error') }, $unset: { leaseId: 1, leaseUntil: 1 } }
                : { $set: { status: 'pending', availableAt: new Date(Date.now() + 5_000), lastError: String(error ?? 'provider_error') }, $unset: { leaseId: 1, leaseUntil: 1 } },
            { returnDocument: 'after', session },
          ).lean();
          if (event && delivered && event.type !== 'calendar.sync.requested') {
            const resolvedConnection = connectionId
              ? await CalendarConnectionModel.findOne({ _id: connectionId, tenantId: event.tenantId, ownerId: event.ownerId }).session(session)
              : await CalendarConnectionModel.findOne({ tenantId: event.tenantId, ownerId: event.ownerId, status: 'active' }).session(session);
            if (event.type === 'event_delete') {
              await CalendarBindingModel.updateOne(
                { tenantId: event.tenantId, ownerId: event.ownerId, taskId: event.aggregateId },
                { $set: { providerDeletedAt: new Date(), ...(providerEtag ? { providerEtag, lastProviderRevision: providerEtag } : {}) } },
                { session },
              );
            } else if (resolvedConnection && providerEventId && providerEtag) {
              await CalendarBindingModel.findOneAndUpdate(
                { tenantId: event.tenantId, ownerId: event.ownerId, taskId: event.aggregateId },
                { $set: {
                  connectionId: resolvedConnection._id,
                  providerEventId,
                  providerEtag,
                  lastProviderRevision: providerEtag,
                  lastTaskRevision: event.aggregateRevision,
                }, $unset: { providerDeletedAt: 1 } },
                { upsert: true, setDefaultsOnInsert: true, session },
              );
            }
          }
        });
      } finally {
        await session.endSession();
      }
      return event ? res.json(event) : res.status(409).json({ error: 'Outbox event lease changed' });
    } catch (error_) { return next(error_); }
  };
  router.post('/outbound/result', acknowledgeOutbox);
  router.post('/outbox/acknowledge', acknowledgeOutbox);

  router.post('/notifications/validate', async (req, res, next) => {
    try {
      const { channelId, resourceId, channelToken, messageNumber } = req.body ?? {};
      const parsedMessageNumber = Number(messageNumber);
      if (
        typeof channelId !== 'string' || !channelId
        || typeof resourceId !== 'string' || !resourceId
        || typeof channelToken !== 'string' || !channelToken
        || !/^\d+$/.test(String(messageNumber ?? ''))
        || !Number.isSafeInteger(parsedMessageNumber)
        || parsedMessageNumber < 1
      ) return res.status(403).json({ valid: false });
      const verificationHash = createHash('sha256').update(channelToken).digest('hex');
      const state = await CalendarSyncStateModel.findOne({
        'watch.channelId': channelId, 'watch.resourceId': resourceId,
        'watch.verificationHash': verificationHash,
        'watch.expiresAt': { $gt: new Date() },
      }).lean();
      if (!state) return res.status(403).json({ valid: false });
      const connection = await CalendarConnectionModel.findOne({
        _id: state.connectionId, tenantId: state.tenantId, ownerId: state.ownerId, status: 'active',
      }).lean();
      if (!connection) return res.status(403).json({ valid: false });
      const advanced = await CalendarSyncStateModel.findOneAndUpdate(
        {
          _id: state._id,
          'watch.channelId': channelId,
          'watch.resourceId': resourceId,
          'watch.verificationHash': verificationHash,
          'watch.expiresAt': { $gt: new Date() },
          $or: [
            { 'watch.lastMessageNumber': { $exists: false } },
            { 'watch.lastMessageNumber': { $lt: parsedMessageNumber } },
          ],
        },
        { $set: { 'watch.lastMessageNumber': parsedMessageNumber } },
        { returnDocument: 'after' },
      ).lean();
      if (!advanced) return res.status(409).json({ valid: false, reason: 'message_replayed' });
      return res.json({
        valid: true,
        tenantId: advanced.tenantId,
        ownerId: advanced.ownerId,
        connectionId: String(connection._id),
        calendarId: connection.calendarId,
        ...(advanced.syncToken ? { syncToken: advanced.syncToken } : {}),
        ...(advanced.pageToken ? { pageToken: advanced.pageToken } : {}),
        signalId: `${advanced.watch!.channelId}:${parsedMessageNumber}`,
      });
    } catch (error) { return next(error); }
  });

  router.post('/watch/renew', async (req, res, next) => {
    try {
      const { tenantId, ownerId, connectionId, channelId, resourceId, verificationHash, expiresAt } = req.body ?? {};
      if (![tenantId, ownerId, connectionId, channelId, resourceId, verificationHash, expiresAt].every((value) => typeof value === 'string' && value)
        || !/^[a-f0-9]{64}$/.test(verificationHash)) {
        return res.status(400).json({ error: 'Invalid calendar watch renewal' });
      }
      const state = await CalendarSyncStateModel.findOneAndUpdate(
        { tenantId, ownerId, connectionId },
        { $set: { watch: { channelId, resourceId, verificationHash, expiresAt: new Date(expiresAt) } } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      ).lean();
      return res.json(state);
    } catch (error) { return next(error); }
  });

  router.post('/reconciliation/claim', async (req, res, next) => {
    try {
      const connections = await CalendarConnectionModel.find({ status: 'active' }).sort({ _id: 1 }).lean();
      const jobs = await Promise.all(connections.map(async (connection) => {
        const state = await CalendarSyncStateModel.findOne({
          tenantId: connection.tenantId, ownerId: connection.ownerId, connectionId: connection._id,
        }).lean();
        return {
          tenantId: connection.tenantId,
          ownerId: connection.ownerId,
          connectionId: String(connection._id),
          calendarId: connection.calendarId,
          operationId: `reconcile:${String(connection._id)}:${new Date().toISOString().slice(0, 10)}`,
          ...(state?.syncToken ? { syncToken: state.syncToken } : {}),
          ...(state?.pageToken ? { pageToken: state.pageToken } : {}),
          fullResyncRequired: state?.fullResyncRequired ?? true,
        };
      }));
      return res.json({ jobs });
    } catch (error) { return next(error); }
  });

  router.post('/status', async (req, res, next) => {
    try {
      const { tenantId, ownerId, connectionId } = req.body ?? {};
      const scope = { tenantId, ownerId, connectionId };
      const [connection, syncState, openConflicts, pendingOutbox] = await Promise.all([
        CalendarConnectionModel.findOne({ _id: connectionId, tenantId, ownerId }).lean(),
        CalendarSyncStateModel.findOne(scope).lean(),
        CalendarConflictModel.countDocuments({ ...scope, status: 'open' }),
        CalendarOutboxModel.countDocuments({ tenantId, ownerId, status: { $in: ['pending', 'leased'] } }),
      ]);
      if (!connection) return res.status(404).json({ error: 'Calendar connection not found' });
      return res.json({ connection, syncState, openConflicts, pendingOutbox });
    } catch (error) { return next(error); }
  });

  return router;
}
