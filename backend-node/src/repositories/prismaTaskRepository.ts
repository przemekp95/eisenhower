import { randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient, type Task as PrismaTask } from '../generated/prisma/client';
import {
  CreateOperation,
  CreateTaskPersistenceResult,
  DelegationTransitionResult,
  LifecycleTransitionResult,
  StoredTask,
  TaskDelegationAssignment,
  TaskDelegationStatus,
  TaskLifecycleAction,
  TaskLifecycleFilter,
  TaskPageCursor,
  TaskPayload,
  TaskPrincipalScope,
  TaskRepository,
  TaskSchedule,
  TaskScope,
  canTransitionDelegation,
  resolveLifecycleTransition,
} from '../application/taskRepository';

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toSchedule(value: Prisma.JsonValue | null): TaskSchedule | undefined {
  const schedule = jsonObject(value);
  if (!schedule || typeof schedule.dueAt !== 'string' || typeof schedule.timeZone !== 'string') return undefined;
  return {
    dueAt: new Date(schedule.dueAt),
    timeZone: schedule.timeZone,
    ...(typeof schedule.remindAt === 'string' ? { remindAt: new Date(schedule.remindAt) } : {}),
  };
}

function toDelegation(value: Prisma.JsonValue | null): StoredTask['delegation'] {
  const delegation = jsonObject(value);
  if (!delegation) return undefined;
  const required = ['assigneeUserId', 'displayLabel', 'handoffNote', 'status', 'offeredAt', 'statusUpdatedAt'];
  if (required.some((key) => typeof delegation[key] !== 'string')) return undefined;
  const result = {
    assigneeUserId: delegation.assigneeUserId as string,
    displayLabel: delegation.displayLabel as string,
    handoffNote: delegation.handoffNote as string,
    status: delegation.status as TaskDelegationStatus,
    offeredAt: new Date(delegation.offeredAt as string),
    statusUpdatedAt: new Date(delegation.statusUpdatedAt as string),
  } as NonNullable<StoredTask['delegation']>;
  for (const key of ['acceptedAt', 'inProgressAt', 'blockedAt', 'completedAt', 'declinedAt'] as const) {
    if (typeof delegation[key] === 'string') result[key] = new Date(delegation[key] as string);
  }
  return result;
}

function scheduleJson(schedule: TaskSchedule): Prisma.InputJsonValue {
  return {
    dueAt: schedule.dueAt.toISOString(),
    timeZone: schedule.timeZone,
    ...(schedule.remindAt ? { remindAt: schedule.remindAt.toISOString() } : {}),
  };
}

function delegationJson(delegation: NonNullable<StoredTask['delegation']>): Prisma.InputJsonValue {
  return Object.fromEntries(Object.entries(delegation).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ])) as Prisma.InputJsonValue;
}

function toStoredTask(task: PrismaTask): StoredTask {
  const schedule = toSchedule(task.schedule);
  const delegation = toDelegation(task.delegation);
  return {
    _id: task.id,
    tenantId: task.tenantId,
    ownerId: task.ownerId,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    title: task.title,
    description: task.description,
    urgent: task.urgent,
    important: task.important,
    lifecycleState: task.lifecycleState as StoredTask['lifecycleState'],
    ...(schedule ? { schedule } : {}),
    ...(delegation ? { delegation } : {}),
    revision: task.revision,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export class PrismaTaskRepository implements TaskRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(scope: TaskScope, id: string) {
    const task = await this.prisma.task.findFirst({
      where: { id, ...scope, deletedAt: null },
    });
    return task ? toStoredTask(task) : null;
  }

  async create(
    scope: TaskScope,
    payload: TaskPayload,
    operation?: CreateOperation
  ): Promise<CreateTaskPersistenceResult> {
    if (!operation) {
      const task = await this.prisma.task.create({
        data: { id: randomBytes(12).toString('hex'), ...scope, ...payload },
      });
      return { task: toStoredTask(task), replayed: false };
    }
    const unique = {
      tenantId_ownerId_createOperationId: { ...scope, createOperationId: operation.id },
    };
    let existing = await this.prisma.task.findUnique({ where: unique });
    if (!existing) {
      try {
        const task = await this.prisma.task.create({
          data: {
            id: randomBytes(12).toString('hex'), ...scope, ...payload,
            createOperationId: operation.id,
            createOperationDigest: operation.payloadDigest,
          },
        });
        return { task: toStoredTask(task), replayed: false };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        existing = await this.prisma.task.findUnique({ where: unique });
        if (!existing) throw error;
      }
    }
    return {
      task: toStoredTask(existing),
      replayed: true,
      storedPayloadDigest: existing.createOperationDigest ?? undefined,
      operationDeleted: existing.deletedAt !== null,
    };
  }

  async listPage(scope: TaskScope, limit: number, cursor?: TaskPageCursor, lifecycle: TaskLifecycleFilter = 'active') {
    const page = await this.prisma.task.findMany({
      where: {
        ...scope,
        deletedAt: null,
        ...(lifecycle === 'all' ? {} : { lifecycleState: lifecycle }),
        ...(cursor ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return {
      tasks: page.slice(0, limit).map(toStoredTask),
      hasNextPage: page.length > limit,
    };
  }

  async update(scope: TaskScope, id: string, expectedRevision: number, patch: Partial<TaskPayload>) {
    const result = await this.prisma.task.updateMany({
      where: { id, ...scope, revision: expectedRevision, deletedAt: null },
      data: { ...patch, revision: { increment: 1 } },
    });
    return result.count === 1 ? this.get(scope, id) : null;
  }

  async transitionLifecycle(scope: TaskScope, id: string, expectedRevision: number, action: TaskLifecycleAction): Promise<LifecycleTransitionResult> {
    const current = await this.prisma.task.findFirst({ where: { id, ...scope, deletedAt: null } });
    if (!current) return { status: 'not_found' };
    if (current.revision !== expectedRevision) return { status: 'revision_conflict' };
    const transition = resolveLifecycleTransition(
      current.lifecycleState as StoredTask['lifecycleState'],
      current.priorLifecycleState as Exclude<StoredTask['lifecycleState'], 'trashed'> | undefined,
      action,
    );
    if (!transition) return { status: 'invalid_transition' };
    const updated = await this.prisma.task.updateMany({
      where: { id, ...scope, revision: expectedRevision, deletedAt: null },
      data: {
        lifecycleState: transition.state,
        priorLifecycleState: transition.previous ?? null,
        revision: { increment: 1 },
      },
    });
    if (updated.count !== 1) return { status: 'revision_conflict' };
    const task = await this.get(scope, id);
    return task ? { status: 'updated', task } : { status: 'not_found' };
  }

  async updateSchedule(scope: TaskScope, id: string, expectedRevision: number, schedule: TaskSchedule | null) {
    const result = await this.prisma.task.updateMany({
      where: { id, ...scope, revision: expectedRevision, deletedAt: null },
      data: {
        schedule: schedule ? scheduleJson(schedule) : Prisma.JsonNull,
        revision: { increment: 1 },
      },
    });
    return result.count === 1 ? this.get(scope, id) : null;
  }

  async listDelegated(scope: TaskPrincipalScope, limit: number, lifecycle: TaskLifecycleFilter) {
    const tasks = await this.prisma.task.findMany({
      where: {
        tenantId: scope.tenantId,
        deletedAt: null,
        ...(lifecycle === 'all' ? {} : { lifecycleState: lifecycle }),
        delegation: { path: ['assigneeUserId'], equals: scope.userId },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return tasks.map(toStoredTask);
  }

  async updateDelegation(scope: TaskScope, id: string, expectedRevision: number, assignment: TaskDelegationAssignment | null) {
    const now = new Date();
    const delegation = assignment ? delegationJson({
      ...assignment,
      status: 'offered',
      offeredAt: now,
      statusUpdatedAt: now,
    }) : Prisma.JsonNull;
    const result = await this.prisma.task.updateMany({
      where: { id, ...scope, revision: expectedRevision, deletedAt: null },
      data: { delegation, revision: { increment: 1 } },
    });
    return result.count === 1 ? this.get(scope, id) : null;
  }

  async transitionDelegation(scope: TaskPrincipalScope, id: string, expectedRevision: number, status: TaskDelegationStatus): Promise<DelegationTransitionResult> {
    const current = await this.prisma.task.findFirst({
      where: {
        id,
        tenantId: scope.tenantId,
        deletedAt: null,
        delegation: { path: ['assigneeUserId'], equals: scope.userId },
      },
    });
    const existing = current ? toStoredTask(current) : null;
    if (!existing?.delegation) return { status: 'not_found' };
    if (current!.revision !== expectedRevision) return { status: 'revision_conflict' };
    if (!canTransitionDelegation(existing.delegation.status, status)) return { status: 'invalid_transition' };
    const now = new Date();
    const timestampField = {
      accepted: 'acceptedAt', in_progress: 'inProgressAt', blocked: 'blockedAt',
      completed: 'completedAt', declined: 'declinedAt',
    } as const;
    const next = {
      ...existing.delegation,
      status,
      statusUpdatedAt: now,
      ...(status === 'offered' ? {} : { [timestampField[status]]: now }),
    };
    const updated = await this.prisma.task.updateMany({
      where: { id, tenantId: scope.tenantId, revision: expectedRevision, deletedAt: null },
      data: { delegation: delegationJson(next), revision: { increment: 1 } },
    });
    if (updated.count !== 1) return { status: 'revision_conflict' };
    const task = await this.prisma.task.findUnique({ where: { id } });
    return task ? { status: 'updated', task: toStoredTask(task) } : { status: 'not_found' };
  }

  async getLifecycleState(scope: TaskScope, id: string) {
    const task = await this.prisma.task.findFirst({
      where: { id, ...scope, deletedAt: null }, select: { lifecycleState: true },
    });
    return task ? task.lifecycleState as StoredTask['lifecycleState'] : null;
  }

  async delete(scope: TaskScope, id: string, expectedRevision: number) {
    const current = await this.prisma.task.findFirst({
      where: { id, ...scope, lifecycleState: 'trashed', revision: expectedRevision, deletedAt: null },
    });
    if (!current) return null;
    const result = current.createOperationId
      ? await this.prisma.task.updateMany({
        where: { id, ...scope, lifecycleState: 'trashed', revision: expectedRevision, deletedAt: null },
        data: {
          title: '[deleted]', description: '', urgent: false, important: false,
          projectId: null, schedule: Prisma.JsonNull, delegation: Prisma.JsonNull,
          priorLifecycleState: null, deletedAt: new Date(), revision: { increment: 1 },
        },
      })
      : await this.prisma.task.deleteMany({
        where: { id, ...scope, lifecycleState: 'trashed', revision: expectedRevision, deletedAt: null },
      });
    return result.count === 1 ? toStoredTask(current) : null;
  }

  async exists(scope: TaskScope, id: string) {
    return (await this.prisma.task.count({ where: { id, ...scope, deletedAt: null } })) > 0;
  }
}
