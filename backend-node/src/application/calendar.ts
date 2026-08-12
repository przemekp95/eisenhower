import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import {
  CalendarBindingModel,
  CalendarConflictModel,
  CalendarDomainAuditModel,
  CalendarMutationReceiptModel,
  CalendarOutboxModel,
  CalendarSyncStateModel,
} from '../models/calendar';
import { TaskModel } from '../models/task';

export interface CalendarScope { tenantId: string; ownerId: string }

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
    await CalendarMutationReceiptModel.create({ ...scope, operationId, fingerprint: digest, outcome: 'accepted', result: { eventId } });
    await CalendarOutboxModel.create({
      eventId, ...scope, aggregateId: connectionId, aggregateRevision: 0,
      type: 'calendar.sync.requested', payload: { connectionId }, status: 'pending',
    });
    return { eventId };
  }
}
