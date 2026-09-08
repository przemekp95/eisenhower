import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import {
  CalendarBindingModel,
  CalendarConnectionModel,
  CalendarConflictModel,
  CalendarDomainAuditModel,
  CalendarMutationReceiptModel,
  CalendarOutboxModel,
  CalendarSyncStateModel,
} from '../models/calendar';
import { TaskModel } from '../models/task';

export interface CalendarScope { tenantId: string; ownerId: string }

export interface CalendarConflictResolutionCommand extends CalendarScope {
  operationId: string;
  actorId: string;
  conflictId: string;
  expectedRevision: number;
  strategy: 'eisenhower' | 'google';
}

export interface CalendarDeletionResolutionCommand extends CalendarScope {
  operationId: string;
  actorId: string;
  bindingId: string;
  expectedTaskRevision: number;
  strategy: 'clear_date' | 'recreate' | 'detach';
}

export type CalendarInboundCommand =
  | (CalendarScope & { operationId: string; connectionId: string; kind: 'sync_token_gone' })
  | (CalendarScope & {
      operationId: string;
      connectionId: string;
      kind: 'sync_checkpoint';
      nextPageToken?: string;
      nextSyncToken?: string;
    })
  | (CalendarScope & {
      operationId: string;
      connectionId: string;
      kind: 'event_deleted';
      providerEventId: string;
      providerEtag: string;
    })
  | (CalendarScope & {
      operationId: string;
      connectionId: string;
      kind: 'event_changed';
      providerEventId: string;
      providerEtag: string;
      title: string;
      dueAt: string;
      timeZone: string;
    });

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function withReceipt(
  command: CalendarInboundCommand,
  execute: (session: mongoose.ClientSession) => Promise<Record<string, unknown> & { outcome: string }>,
) {
  const digest = fingerprint(command);
  const existing = await CalendarMutationReceiptModel.findOne({
    tenantId: command.tenantId, ownerId: command.ownerId, operationId: command.operationId,
  }).lean();
  if (existing) {
    if (existing.fingerprint !== digest) throw new Error('calendar_operation_reused');
    return existing.result as Record<string, unknown>;
  }
  const session = await mongoose.startSession();
  let result: Record<string, unknown> = {};
  try {
    await session.withTransaction(async () => {
      result = await execute(session);
      await CalendarMutationReceiptModel.create([{
        tenantId: command.tenantId, ownerId: command.ownerId,
        operationId: command.operationId, fingerprint: digest,
        outcome: result.outcome, result,
      }], { session });
      await CalendarDomainAuditModel.create([{
        eventId: command.operationId, tenantId: command.tenantId, ownerId: command.ownerId,
        actorId: 'n8n-calendar', action: `calendar.${command.kind}`,
        outcome: result.outcome, resourceId: command.connectionId,
        ...(result.reason ? { reason: String(result.reason) } : {}),
      }], { session });
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export class CalendarApplicationService {
  async activeConnection(scope: CalendarScope) {
    return CalendarConnectionModel.findOne({ ...scope, status: 'active' });
  }

  async status(scope: CalendarScope, canConnect: boolean) {
    const connection = await CalendarConnectionModel.findOne({ ...scope, status: 'active' }).lean();
    if (!connection) return { status: 'disconnected', connection: null, canConnect };
    const [syncState, openConflicts, pendingOutbox, failedSyncCount] = await Promise.all([
      CalendarSyncStateModel.findOne({ ...scope, connectionId: connection._id }).lean(),
      CalendarConflictModel.countDocuments({ ...scope, connectionId: connection._id, status: 'open' }),
      CalendarOutboxModel.countDocuments({ ...scope, status: { $in: ['pending', 'leased'] } }),
      CalendarOutboxModel.countDocuments({ ...scope, status: 'dead_letter' }),
    ]);
    return {
      status: syncState?.fullResyncRequired ? 'pending' : 'connected',
      canConnect,
      connection: { id: connection._id, provider: connection.provider, calendarId: connection.calendarId },
      syncState: syncState ? {
        fullResyncRequired: syncState.fullResyncRequired,
        lastRequestedAt: syncState.lastRequestedAt,
        lastCompletedAt: syncState.lastCompletedAt,
      } : null,
      openConflicts, pendingOutbox, failedSyncCount, syncProblem: failedSyncCount > 0,
    };
  }

  listConflicts(scope: CalendarScope) {
    return CalendarConflictModel.find({ ...scope, status: 'open' }).sort({ createdAt: 1 }).lean();
  }

  async listDeletedBindings(scope: CalendarScope) {
    const bindings = await CalendarBindingModel.find({
      ...scope, providerDeletedAt: { $exists: true },
    }).sort({ providerDeletedAt: 1 }).lean();
    const tasks = await TaskModel.find({
      ...scope, _id: { $in: bindings.map((binding) => binding.taskId) },
    }).lean();
    const byId = new Map(tasks.map((task) => [String(task._id), task]));
    return bindings.flatMap((binding) => {
      const task = byId.get(String(binding.taskId));
      return task ? [{
        _id: binding._id,
        taskId: binding.taskId,
        taskTitle: task.title,
        taskRevision: task.revision ?? 0,
        providerEventId: binding.providerEventId,
        providerDeletedAt: binding.providerDeletedAt,
      }] : [];
    });
  }

  async resolveProviderDeletion(command: CalendarDeletionResolutionCommand) {
    const digest = fingerprint({ ...command, kind: 'provider_deletion_resolution' });
    const existing = await CalendarMutationReceiptModel.findOne({
      tenantId: command.tenantId,
      ownerId: command.ownerId,
      operationId: command.operationId,
    }).lean();
    if (existing) {
      if (existing.fingerprint !== digest) throw new Error('calendar_operation_reused');
      return existing.result;
    }

    const session = await mongoose.startSession();
    let result: Record<string, unknown> | undefined;
    try {
      await session.withTransaction(async () => {
        const binding = await CalendarBindingModel.findOne({
          _id: command.bindingId,
          tenantId: command.tenantId,
          ownerId: command.ownerId,
          providerDeletedAt: { $exists: true },
        }).session(session);
        if (!binding) throw new Error('calendar_deleted_binding_not_found');
        const task = await TaskModel.findOne({
          _id: binding.taskId,
          tenantId: command.tenantId,
          ownerId: command.ownerId,
        }).session(session);
        if (!task) throw new Error('calendar_conflict_target_unavailable');
        if ((task.revision ?? 0) !== command.expectedTaskRevision) {
          throw new Error('calendar_task_revision_mismatch');
        }

        if (command.strategy === 'clear_date') {
          task.schedule = undefined;
          task.revision = (task.revision ?? 0) + 1;
          await task.save({ session });
          await binding.deleteOne({ session });
        } else if (command.strategy === 'detach') {
          await binding.deleteOne({ session });
        } else {
          if (!task.schedule) throw new Error('calendar_recreate_schedule_missing');
          await CalendarOutboxModel.create(
            [
              {
                eventId: `provider-deletion:${binding.id}:recreate:${task.revision ?? 0}`,
                tenantId: command.tenantId,
                ownerId: command.ownerId,
                aggregateId: task.id,
                aggregateRevision: task.revision ?? 0,
                type: 'event_create',
                payload: {
                  taskId: task.id,
                  title: task.title,
                  lifecycleState: task.lifecycleState,
                  schedule: task.schedule,
                },
                status: 'pending',
              },
            ],
            { session },
          );
          binding.providerDeletedAt = undefined;
          await binding.save({ session });
        }

        result = {
          outcome: command.strategy,
          taskId: task.id,
          taskRevision: task.revision ?? 0,
        };
        await CalendarMutationReceiptModel.create(
          [
            {
              tenantId: command.tenantId,
              ownerId: command.ownerId,
              operationId: command.operationId,
              fingerprint: digest,
              outcome: command.strategy,
              result,
            },
          ],
          { session },
        );
        await CalendarDomainAuditModel.create(
          [
            {
              eventId: `provider-deletion:${command.bindingId}:${command.operationId}`,
              tenantId: command.tenantId,
              ownerId: command.ownerId,
              actorId: command.actorId,
              action: 'calendar.provider_deletion.resolve',
              outcome: command.strategy,
              resourceId: command.bindingId,
              beforeRevision: command.expectedTaskRevision,
              afterRevision: task.revision ?? 0,
            },
          ],
          { session },
        );
      });
      if (!result) throw new Error('calendar_provider_deletion_resolution_incomplete');
      return result;
    } finally {
      await session.endSession();
    }
  }

  async applyInbound(command: CalendarInboundCommand) {
    return withReceipt(command, async (session) => {
      const scope = { tenantId: command.tenantId, ownerId: command.ownerId };
      if (command.kind === 'sync_token_gone') {
        await CalendarSyncStateModel.findOneAndUpdate(
          { ...scope, connectionId: command.connectionId },
          { $unset: { syncToken: 1, pageToken: 1 }, $set: { fullResyncRequired: true } },
          { upsert: true, session, setDefaultsOnInsert: true },
        );
        return { outcome: 'full_resync_required' };
      }
      if (command.kind === 'sync_checkpoint') {
        if (!command.nextPageToken && !command.nextSyncToken) {
          return { outcome: 'rejected', reason: 'checkpoint_token_missing' };
        }
        await CalendarSyncStateModel.findOneAndUpdate(
          { ...scope, connectionId: command.connectionId },
          command.nextSyncToken
            ? {
                $set: {
                  syncToken: command.nextSyncToken,
                  fullResyncRequired: false,
                  lastCompletedAt: new Date(),
                },
                $unset: { pageToken: 1 },
              }
            : { $set: { pageToken: command.nextPageToken, fullResyncRequired: false } },
          { upsert: true, session, setDefaultsOnInsert: true },
        );
        return { outcome: command.nextSyncToken ? 'sync_completed' : 'page_checkpointed' };
      }

      const binding = await CalendarBindingModel.findOne({
        ...scope, connectionId: command.connectionId, providerEventId: command.providerEventId,
      }).session(session);
      if (!binding) return { outcome: 'ignored', reason: 'binding_not_found' };

      if (command.kind === 'event_deleted') {
        binding.providerEtag = command.providerEtag;
        binding.lastProviderRevision = command.providerEtag;
        binding.providerDeletedAt = new Date();
        await binding.save({ session });
        return { outcome: 'provider_deleted_task_preserved' };
      }

      const task = await TaskModel.findOne({ _id: binding.taskId, ...scope }).session(session);
      if (!task) return { outcome: 'ignored', reason: 'task_not_found' };
      const localChanged = (task.revision ?? 0) !== binding.lastTaskRevision;
      const providerChanged = command.providerEtag !== binding.lastProviderRevision;
      if (localChanged && providerChanged) {
        await CalendarConflictModel.updateOne(
          { bindingId: binding._id, taskRevision: task.revision ?? 0, providerRevision: command.providerEtag },
          { $setOnInsert: {
            ...scope, connectionId: binding.connectionId, bindingId: binding._id, taskId: task._id,
            taskRevision: task.revision ?? 0, providerRevision: command.providerEtag,
            providerSnapshot: { title: command.title, dueAt: command.dueAt, timeZone: command.timeZone },
            status: 'open',
          } },
          { upsert: true, session },
        );
        return { outcome: 'conflict' };
      }

      task.title = command.title;
      task.schedule = { dueAt: new Date(command.dueAt), timeZone: command.timeZone };
      task.revision = (task.revision ?? 0) + 1;
      await task.save({ session });
      binding.providerEtag = command.providerEtag;
      binding.lastProviderRevision = command.providerEtag;
      binding.lastTaskRevision = task.revision;
      await binding.save({ session });
      return { outcome: 'applied', revision: task.revision };
    });
  }

  async requestSync(scope: CalendarScope, connectionId: string, operationId: string) {
    const command = { ...scope, connectionId, operationId, kind: 'sync_token_gone' as const };
    const digest = fingerprint({ ...command, kind: 'sync_request' });
    const existing = await CalendarMutationReceiptModel.findOne({ ...scope, operationId }).lean();
    if (existing) {
      if (existing.fingerprint !== digest) throw new Error('calendar_operation_reused');
      return existing.result;
    }
    const eventId = randomUUID();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await CalendarOutboxModel.updateMany(
          { ...scope, status: 'dead_letter' },
          {
            $set: { status: 'pending', attempts: 0, availableAt: new Date() },
            $unset: { leaseId: 1, leaseUntil: 1, lastError: 1 },
          },
          { session },
        );
        await CalendarMutationReceiptModel.create([{
          ...scope, operationId, fingerprint: digest, outcome: 'accepted', result: { eventId },
        }], { session });
        await CalendarOutboxModel.create([{
          eventId, ...scope, aggregateId: connectionId, aggregateRevision: 0,
          type: 'calendar.sync.requested', payload: { connectionId }, status: 'pending',
        }], { session });
        await CalendarSyncStateModel.findOneAndUpdate(
          { ...scope, connectionId },
          { $set: { lastRequestedAt: new Date() } },
          { upsert: true, setDefaultsOnInsert: true, session },
        );
      });
    } finally {
      await session.endSession();
    }
    return { eventId };
  }

  async resolveConflict(command: CalendarConflictResolutionCommand) {
    const digest = fingerprint({ ...command, kind: 'conflict_resolution' });
    const existing = await CalendarMutationReceiptModel.findOne({
      tenantId: command.tenantId, ownerId: command.ownerId, operationId: command.operationId,
    }).lean();
    if (existing) {
      if (existing.fingerprint !== digest) throw new Error('calendar_operation_reused');
      return existing.result as { conflict: Record<string, unknown>; revision: number };
    }

    const session = await mongoose.startSession();
    let result: { conflict: Record<string, unknown>; revision: number } | undefined;
    try {
      await session.withTransaction(async () => {
        const conflict = await CalendarConflictModel.findOne({
          _id: command.conflictId, tenantId: command.tenantId,
          ownerId: command.ownerId, status: 'open',
        }).session(session);
        if (!conflict) throw new Error('calendar_conflict_not_found');
        if ((conflict.get('revision') ?? 0) !== command.expectedRevision) {
          throw new Error('calendar_conflict_revision_mismatch');
        }
        const binding = await CalendarBindingModel.findOne({
          _id: conflict.bindingId, tenantId: command.tenantId, ownerId: command.ownerId,
        }).session(session);
        const task = await TaskModel.findOne({
          _id: conflict.taskId, tenantId: command.tenantId, ownerId: command.ownerId,
        }).session(session);
        if (!binding || !task) throw new Error('calendar_conflict_target_unavailable');

        if (command.strategy === 'google') {
          const snapshot = conflict.providerSnapshot as { title: string; dueAt: string; timeZone: string };
          task.title = snapshot.title;
          task.schedule = { dueAt: new Date(snapshot.dueAt), timeZone: snapshot.timeZone };
          task.revision = (task.revision ?? 0) + 1;
          await task.save({ session });
          binding.lastTaskRevision = task.revision;
          binding.lastProviderRevision = conflict.providerRevision;
          binding.providerEtag = conflict.providerRevision;
          await binding.save({ session });
        } else {
          await CalendarOutboxModel.create([{
            eventId: `conflict:${conflict.id}:${command.expectedRevision}`,
            tenantId: command.tenantId, ownerId: command.ownerId,
            aggregateId: task.id, aggregateRevision: task.revision ?? 0,
            type: 'event_update',
            payload: { taskId: task.id, title: task.title, schedule: task.schedule, bindingId: binding.id },
            status: 'pending',
          }], { session });
        }
        conflict.status = command.strategy === 'google' ? 'resolved_provider' : 'resolved_local';
        conflict.resolvedAt = new Date();
        conflict.set('revision', command.expectedRevision + 1);
        await conflict.save({ session });
        const nextRevision = command.expectedRevision + 1;
        result = { conflict: conflict.toObject(), revision: nextRevision };
        await CalendarMutationReceiptModel.create([{
          tenantId: command.tenantId, ownerId: command.ownerId,
          operationId: command.operationId, fingerprint: digest,
          outcome: 'success', result,
        }], { session });
        await CalendarDomainAuditModel.create([{
          eventId: `resolve:${conflict.id}:${command.expectedRevision}`,
          tenantId: command.tenantId, ownerId: command.ownerId, actorId: command.actorId,
          action: 'calendar.conflict.resolve', outcome: 'success', resourceId: conflict.id,
          beforeRevision: command.expectedRevision, afterRevision: nextRevision,
        }], { session });
      });
      if (!result) throw new Error('calendar_conflict_resolution_incomplete');
      return result;
    } finally {
      await session.endSession();
    }
  }
}
