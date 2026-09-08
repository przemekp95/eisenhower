import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import {
  CalendarBindingModel,
  CalendarConflictModel,
  CalendarConnectionModel,
  CalendarInternalRequestReceiptModel,
  CalendarOutboxModel,
  CalendarSyncStateModel,
} from '../models/calendar';
import type { CalendarInboundCommand } from './calendar';

const MAX_OUTBOX_ATTEMPTS = 5;
const OUTBOX_LEASE_MS = 35 * 60_000;

export interface InternalResult { status: number; body?: unknown }
export interface InternalReceiptContext { requestId: string; fingerprint: string }

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

export class CalendarInternalService {
  async claimOutbox(context: InternalReceiptContext): Promise<InternalResult> {
    const now = new Date();
    const leaseId = randomUUID();
    let status = 204;
    let body: Record<string, unknown> | undefined;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await CalendarOutboxModel.updateMany(
          { status: 'leased', leaseUntil: { $lte: now }, attempts: { $gte: MAX_OUTBOX_ATTEMPTS } },
          {
            $set: { status: 'dead_letter', lastError: 'calendar_dispatch_attempts_exhausted' },
            $unset: { leaseId: 1, leaseUntil: 1 },
          },
          { session },
        );
        const event = await CalendarOutboxModel.findOneAndUpdate(
          {
            attempts: { $lt: MAX_OUTBOX_ATTEMPTS },
            $or: [
              { status: 'pending', availableAt: { $lte: now } },
              { status: 'leased', leaseUntil: { $lte: now } },
            ],
          },
          {
            $set: { status: 'leased', leaseId, leaseUntil: new Date(now.getTime() + OUTBOX_LEASE_MS) },
            $inc: { attempts: 1 },
          },
          { sort: { availableAt: 1 }, returnDocument: 'after', session },
        ).lean();
        if (event) {
          const connection = await CalendarConnectionModel.findOne({
            tenantId: event.tenantId, ownerId: event.ownerId, status: 'active',
          }).session(session).lean();
          const binding = await CalendarBindingModel.findOne({
            tenantId: event.tenantId, ownerId: event.ownerId, taskId: event.aggregateId,
          }).session(session).lean();
          const syncState = event.type === 'calendar.sync.requested'
            ? await CalendarSyncStateModel.findOne({
              tenantId: event.tenantId, ownerId: event.ownerId, connectionId: connection?._id,
            }).session(session).lean()
            : null;
          if (!connection || (['event_update', 'event_delete'].includes(event.type) && !binding)) {
            await CalendarOutboxModel.updateOne(
              { _id: event._id },
              {
                $set: {
                  status: 'dead_letter',
                  lastError: connection ? 'calendar_binding_missing' : 'calendar_connection_missing',
                },
                $unset: { leaseId: 1, leaseUntil: 1 },
              },
              { session },
            );
            status = 409;
            body = { error: 'Calendar dispatch target is unavailable' };
          } else {
            status = 200;
            body = {
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
            };
          }
        }
        await CalendarInternalRequestReceiptModel.updateOne(
          { requestId: context.requestId, fingerprint: context.fingerprint, status: 'pending' },
          { $set: { status: 'completed', statusCode: status, responseBody: body } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    return { status, body };
  }

  async acknowledgeOutbox(input: Record<string, unknown>): Promise<InternalResult> {
    const {
      eventId, leaseId, delivered, error, providerEventId, providerEtag, connectionId,
    } = input;
    if (typeof eventId !== 'string' || !eventId || typeof delivered !== 'boolean') {
      return { status: 400, body: { error: 'Invalid calendar outbox acknowledgement' } };
    }
    const leased = await CalendarOutboxModel.findOne({ eventId, status: 'leased' }).lean();
    if (!leased) return { status: 404, body: { error: 'Outbox event not found' } };
    if (leased.leaseId && leaseId !== leased.leaseId) {
      return { status: 409, body: { error: 'Outbox event lease changed' } };
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
              ? {
                $set: { status: 'dead_letter', lastError: String(error ?? 'provider_error') },
                $unset: { leaseId: 1, leaseUntil: 1 },
              }
              : {
                $set: {
                  status: 'pending', availableAt: new Date(Date.now() + 5_000),
                  lastError: String(error ?? 'provider_error'),
                },
                $unset: { leaseId: 1, leaseUntil: 1 },
              },
          { returnDocument: 'after', session },
        ).lean();
        if (event && delivered && event.type !== 'calendar.sync.requested') {
          const resolvedConnection = connectionId
            ? await CalendarConnectionModel.findOne({
              _id: connectionId, tenantId: event.tenantId, ownerId: event.ownerId,
            }).session(session)
            : await CalendarConnectionModel.findOne({
              tenantId: event.tenantId, ownerId: event.ownerId, status: 'active',
            }).session(session);
          if (event.type === 'event_delete') {
            await CalendarBindingModel.updateOne(
              { tenantId: event.tenantId, ownerId: event.ownerId, taskId: event.aggregateId },
              {
                $set: {
                  providerDeletedAt: new Date(),
                  ...(providerEtag ? { providerEtag, lastProviderRevision: providerEtag } : {}),
                },
              },
              { session },
            );
          } else if (resolvedConnection && providerEventId && providerEtag) {
            await CalendarBindingModel.findOneAndUpdate(
              { tenantId: event.tenantId, ownerId: event.ownerId, taskId: event.aggregateId },
              {
                $set: {
                  connectionId: resolvedConnection._id,
                  providerEventId,
                  providerEtag,
                  lastProviderRevision: providerEtag,
                  lastTaskRevision: event.aggregateRevision,
                },
                $unset: { providerDeletedAt: 1 },
              },
              { upsert: true, setDefaultsOnInsert: true, session },
            );
          }
        }
      });
    } finally {
      await session.endSession();
    }
    return event
      ? { status: 200, body: event }
      : { status: 409, body: { error: 'Outbox event lease changed' } };
  }

  async validateNotification(input: Record<string, unknown>): Promise<InternalResult> {
    const { channelId, resourceId, channelToken, messageNumber } = input;
    const parsedMessageNumber = Number(messageNumber);
    if (
      typeof channelId !== 'string' || !channelId
      || typeof resourceId !== 'string' || !resourceId
      || typeof channelToken !== 'string' || !channelToken
      || !/^\d+$/.test(String(messageNumber ?? ''))
      || !Number.isSafeInteger(parsedMessageNumber)
      || parsedMessageNumber < 1
    ) return { status: 403, body: { valid: false } };
    const verificationHash = createHash('sha256').update(channelToken).digest('hex');
    const state = await CalendarSyncStateModel.findOne({
      'watch.channelId': channelId,
      'watch.resourceId': resourceId,
      'watch.verificationHash': verificationHash,
      'watch.expiresAt': { $gt: new Date() },
    }).lean();
    if (!state) return { status: 403, body: { valid: false } };
    const connection = await CalendarConnectionModel.findOne({
      _id: state.connectionId, tenantId: state.tenantId, ownerId: state.ownerId, status: 'active',
    }).lean();
    if (!connection) return { status: 403, body: { valid: false } };
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
    if (!advanced) return { status: 409, body: { valid: false, reason: 'message_replayed' } };
    return {
      status: 200,
      body: {
        valid: true,
        tenantId: advanced.tenantId,
        ownerId: advanced.ownerId,
        connectionId: String(connection._id),
        calendarId: connection.calendarId,
        ...(advanced.syncToken ? { syncToken: advanced.syncToken } : {}),
        ...(advanced.pageToken ? { pageToken: advanced.pageToken } : {}),
        signalId: `${advanced.watch!.channelId}:${parsedMessageNumber}`,
      },
    };
  }

  async renewWatch(input: Record<string, unknown>): Promise<InternalResult> {
    const {
      tenantId, ownerId, connectionId, channelId, resourceId, verificationHash, expiresAt,
    } = input;
    if (![tenantId, ownerId, connectionId, channelId, resourceId, verificationHash, expiresAt]
      .every((value) => typeof value === 'string' && value)
      || !/^[a-f0-9]{64}$/.test(String(verificationHash))) {
      return { status: 400, body: { error: 'Invalid calendar watch renewal' } };
    }
    const state = await CalendarSyncStateModel.findOneAndUpdate(
      { tenantId, ownerId, connectionId },
      {
        $set: {
          watch: {
            channelId, resourceId, verificationHash,
            expiresAt: new Date(expiresAt as string),
          },
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();
    return { status: 200, body: state };
  }

  async claimReconciliation(): Promise<InternalResult> {
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
    return { status: 200, body: { jobs } };
  }

  async status(input: Record<string, unknown>): Promise<InternalResult> {
    const { tenantId, ownerId, connectionId } = input;
    const scope = { tenantId, ownerId, connectionId };
    const [connection, syncState, openConflicts, pendingOutbox] = await Promise.all([
      CalendarConnectionModel.findOne({ _id: connectionId, tenantId, ownerId }).lean(),
      CalendarSyncStateModel.findOne(scope).lean(),
      CalendarConflictModel.countDocuments({ ...scope, status: 'open' }),
      CalendarOutboxModel.countDocuments({
        tenantId, ownerId, status: { $in: ['pending', 'leased'] },
      }),
    ]);
    if (!connection) return { status: 404, body: { error: 'Calendar connection not found' } };
    return { status: 200, body: { connection, syncState, openConflicts, pendingOutbox } };
  }
}
