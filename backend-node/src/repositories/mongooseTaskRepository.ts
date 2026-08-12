import mongoose, { type QueryFilter } from 'mongoose';
import {
  CreateOperation,
  CreateTaskPersistenceResult,
  DelegationTransitionResult,
  LifecycleTransitionResult,
  StoredTask,
  TaskPageCursor,
  TaskPayload,
  TaskDelegationAssignment,
  TaskDelegationStatus,
  TaskPrincipalScope,
  TaskSchedule,
  TaskRepository,
  TaskScope,
  TaskLifecycleAction,
  TaskLifecycleFilter,
  TaskLifecycleState,
  canTransitionDelegation,
  resolveLifecycleTransition,
} from '../application/taskRepository';
import { Task, TaskModel } from '../models/task';
import { CalendarBindingModel, CalendarDomainAuditModel, CalendarOutboxModel } from '../models/calendar';

type PersistedTask = Omit<Task, 'lifecycleState'> & {
  _id: unknown;
  createOperationDigest?: string;
  deletedAt?: Date;
  lifecycleState?: TaskLifecycleState;
  priorLifecycleState?: Exclude<TaskLifecycleState, 'trashed'>;
  createdAt: Date;
  updatedAt: Date;
};

function revisionFilter(expectedRevision: number) {
  if (expectedRevision === 0) {
    return { $or: [{ revision: 0 }, { revision: { $exists: false } }] };
  }
  return { revision: expectedRevision };
}

async function enqueueCalendarTaskEvent(
  session: mongoose.ClientSession,
  scope: TaskScope,
  task: StoredTask,
  type: 'event_create' | 'event_update' | 'event_delete',
) {
  await CalendarOutboxModel.create([{
    eventId: `task:${task._id}:${type}:${task.revision}`,
    ...scope,
    aggregateId: task._id,
    aggregateRevision: task.revision,
    type,
    payload: {
      taskId: task._id,
      title: task.title,
      lifecycleState: task.lifecycleState,
      schedule: task.schedule ?? null,
    },
    status: 'pending',
  }], { session });
}

function toStoredTask(task: PersistedTask): StoredTask {
  return {
    _id: String(task._id),
    tenantId: task.tenantId,
    ownerId: task.ownerId,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    title: task.title,
    description: task.description ?? '',
    urgent: task.urgent,
    important: task.important,
    lifecycleState: task.lifecycleState ?? 'active',
    ...(task.schedule ? { schedule: task.schedule } : {}),
    ...(task.delegation ? { delegation: task.delegation } : {}),
    revision: task.revision ?? 0,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export class MongooseTaskRepository implements TaskRepository {
  async get(scope: TaskScope, id: string) {
    const task = await TaskModel.findOne({ _id: id, ...scope, deletedAt: { $exists: false } }).lean();
    return task ? toStoredTask(task as PersistedTask) : null;
  }
  async listPage(
    scope: TaskScope,
    limit: number,
    cursor?: TaskPageCursor,
    lifecycle: TaskLifecycleFilter = 'active'
  ) {
    const lifecycleScope: QueryFilter<Task> =
      lifecycle === 'all'
        ? {}
        : lifecycle === 'active'
          ? { $or: [{ lifecycleState: 'active' as const }, { lifecycleState: { $exists: false } }] }
          : { lifecycleState: lifecycle };
    const constraints: QueryFilter<Task>[] = [
      { ...scope, deletedAt: { $exists: false } },
      lifecycleScope,
    ];
    if (cursor) {
      constraints.push({
        $or: [
          { createdAt: { $lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
        ],
      });
    }
    const filter: QueryFilter<Task> = { $and: constraints };
    const page = await TaskModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasNextPage = page.length > limit;
    return {
      tasks: (hasNextPage ? page.slice(0, limit) : page).map((task) =>
        toStoredTask(task as PersistedTask)
      ),
      hasNextPage,
    };
  }

  async create(
    scope: TaskScope,
    payload: TaskPayload,
    operation?: CreateOperation
  ): Promise<CreateTaskPersistenceResult> {
    if (!operation) {
      const task = await TaskModel.create({ ...scope, ...payload });
      return { task: toStoredTask(task.toObject() as PersistedTask), replayed: false };
    }

    const result = await TaskModel.updateOne(
      { ...scope, createOperationId: operation.id },
      {
        $setOnInsert: {
          ...scope,
          ...payload,
          revision: 0,
          createOperationId: operation.id,
          createOperationDigest: operation.payloadDigest,
        },
      },
      { upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    const task = (await TaskModel.findOne({ ...scope, createOperationId: operation.id })
      .select('+createOperationDigest +deletedAt')
      .lean()) as PersistedTask | null;
    if (!task) {
      throw new Error('Idempotent task create did not return a task');
    }

    return {
      task: toStoredTask(task),
      replayed: result.upsertedCount === 0,
      storedPayloadDigest: task.createOperationDigest,
      operationDeleted: task.deletedAt instanceof Date,
    };
  }

  async update(
    scope: TaskScope,
    id: string,
    expectedRevision: number,
    patch: Partial<TaskPayload>
  ) {
    const session = await mongoose.startSession();
    let stored: StoredTask | null = null;
    try {
      await session.withTransaction(async () => {
        const task = await TaskModel.findOneAndUpdate(
          { _id: id, ...scope, deletedAt: { $exists: false }, ...revisionFilter(expectedRevision) },
          { $set: patch, $inc: { revision: 1 } },
          { returnDocument: 'after', runValidators: true, session }
        );
        if (!task) return;
        stored = toStoredTask(task.toObject() as PersistedTask);
        const binding = await CalendarBindingModel.exists({ ...scope, taskId: id }).session(session);
        if (binding) await enqueueCalendarTaskEvent(session, scope, stored, 'event_update');
      });
      return stored;
    } finally { await session.endSession(); }
  }

  async transitionLifecycle(
    scope: TaskScope,
    id: string,
    expectedRevision: number,
    action: TaskLifecycleAction
  ): Promise<LifecycleTransitionResult> {
    const current = (await TaskModel.findOne({ _id: id, ...scope, deletedAt: { $exists: false } })
      .select('+priorLifecycleState')
      .lean()) as PersistedTask | null;
    if (!current) return { status: 'not_found' };
    if ((current.revision ?? 0) !== expectedRevision) return { status: 'revision_conflict' };

    const transition = resolveLifecycleTransition(
      current.lifecycleState ?? 'active',
      current.priorLifecycleState,
      action
    );
    if (!transition) return { status: 'invalid_transition' };

    const session = await mongoose.startSession();
    try {
      let stored: StoredTask | null = null;
      await session.withTransaction(async () => {
        const task = await TaskModel.findOneAndUpdate(
          { _id: id, ...scope, deletedAt: { $exists: false }, ...revisionFilter(expectedRevision) },
          {
            $set: {
              lifecycleState: transition.state,
              ...(transition.previous ? { priorLifecycleState: transition.previous } : {}),
            },
            ...(!transition.previous ? { $unset: { priorLifecycleState: 1 } } : {}),
            $inc: { revision: 1 },
          },
          { returnDocument: 'after', runValidators: true, session }
        );
        if (!task) return;
        stored = toStoredTask(task.toObject() as PersistedTask);
        const binding = await CalendarBindingModel.exists({ ...scope, taskId: id }).session(session);
        if (binding) {
          const type = ['archived', 'trashed'].includes(stored.lifecycleState) ? 'event_delete' : 'event_update';
          await enqueueCalendarTaskEvent(session, scope, stored, type);
        }
      });
      return stored ? { status: 'updated', task: stored } : { status: 'revision_conflict' };
    } finally { await session.endSession(); }
  }

  async updateSchedule(
    scope: TaskScope,
    id: string,
    expectedRevision: number,
    schedule: TaskSchedule | null
  ) {
    const session = await mongoose.startSession();
    let stored: StoredTask | null = null;
    try {
      await session.withTransaction(async () => {
        const task = await TaskModel.findOneAndUpdate(
          { _id: id, ...scope, deletedAt: { $exists: false }, ...revisionFilter(expectedRevision) },
          schedule
            ? { $set: { schedule }, $inc: { revision: 1 } }
            : { $unset: { schedule: 1 }, $inc: { revision: 1 } },
          { returnDocument: 'after', runValidators: true, session }
        );
        if (!task) return;
        stored = toStoredTask(task.toObject() as PersistedTask);
        const binding = await CalendarBindingModel.exists({ ...scope, taskId: id }).session(session);
        await enqueueCalendarTaskEvent(
          session,
          scope,
          stored,
          schedule ? (binding ? 'event_update' : 'event_create') : 'event_delete',
        );
        await CalendarDomainAuditModel.create([{
          eventId: `task:${id}:schedule:${stored.revision}`,
          ...scope,
          actorId: scope.ownerId,
          action: schedule ? 'task.schedule.set' : 'task.schedule.clear',
          outcome: 'success',
          resourceId: id,
          beforeRevision: expectedRevision,
          afterRevision: stored.revision,
        }], { session });
      });
      return stored;
    } finally {
      await session.endSession();
    }
  }

  async listDelegated(scope: TaskPrincipalScope, limit: number) {
    const tasks = await TaskModel.find({
      tenantId: scope.tenantId,
      'delegation.assigneeUserId': scope.userId,
      deletedAt: { $exists: false },
    })
      .sort({ 'delegation.statusUpdatedAt': -1, _id: -1 })
      .limit(limit)
      .lean();
    return tasks.map((task) => toStoredTask(task as PersistedTask));
  }

  async updateDelegation(
    scope: TaskScope,
    id: string,
    expectedRevision: number,
    delegation: TaskDelegationAssignment | null
  ) {
    const now = new Date();
    const update = delegation
      ? {
        $set: {
          delegation: {
            ...delegation,
            status: 'offered' as const,
            offeredAt: now,
            statusUpdatedAt: now,
          },
        },
        $inc: { revision: 1 },
      }
      : { $unset: { delegation: 1 }, $inc: { revision: 1 } };
    const task = await TaskModel.findOneAndUpdate(
      { _id: id, ...scope, deletedAt: { $exists: false }, ...revisionFilter(expectedRevision) },
      update,
      { returnDocument: 'after', runValidators: true }
    );
    return task ? toStoredTask(task.toObject() as PersistedTask) : null;
  }

  async transitionDelegation(
    scope: TaskPrincipalScope,
    id: string,
    expectedRevision: number,
    status: TaskDelegationStatus
  ): Promise<DelegationTransitionResult> {
    const filter = {
      _id: id,
      tenantId: scope.tenantId,
      'delegation.assigneeUserId': scope.userId,
      deletedAt: { $exists: false },
    };
    const current = (await TaskModel.findOne(filter)
      .select('revision delegation')
      .lean()) as Pick<PersistedTask, 'revision' | 'delegation'> | null;
    if (!current?.delegation) return { status: 'not_found' };
    if ((current.revision ?? 0) !== expectedRevision) return { status: 'revision_conflict' };
    if (!canTransitionDelegation(current.delegation.status, status)) {
      return { status: 'invalid_transition' };
    }

    const transitionedStatus = status as Exclude<TaskDelegationStatus, 'offered'>;
    const timestampField: Record<Exclude<TaskDelegationStatus, 'offered'>, string> = {
      accepted: 'delegation.acceptedAt',
      in_progress: 'delegation.inProgressAt',
      blocked: 'delegation.blockedAt',
      completed: 'delegation.completedAt',
      declined: 'delegation.declinedAt',
    };
    const now = new Date();
    const task = await TaskModel.findOneAndUpdate(
      {
        ...filter,
        'delegation.status': current.delegation.status,
        ...revisionFilter(expectedRevision),
      },
      {
        $set: {
          'delegation.status': status,
          'delegation.statusUpdatedAt': now,
          [timestampField[transitionedStatus]]: now,
        },
        $inc: { revision: 1 },
      },
      { returnDocument: 'after', runValidators: true }
    );
    return task
      ? { status: 'updated', task: toStoredTask(task.toObject() as PersistedTask) }
      : { status: 'revision_conflict' };
  }

  async getLifecycleState(scope: TaskScope, id: string) {
    const task = (await TaskModel.findOne({ _id: id, ...scope, deletedAt: { $exists: false } })
      .select('lifecycleState')
      .lean()) as Pick<PersistedTask, 'lifecycleState'> | null;
    return task ? (task.lifecycleState ?? 'active') : null;
  }

  async delete(scope: TaskScope, id: string, expectedRevision: number) {
    const filter: QueryFilter<Task> = {
      _id: id,
      ...scope,
      deletedAt: { $exists: false },
      lifecycleState: 'trashed' as const,
      ...revisionFilter(expectedRevision),
    };
    const idempotentTask = await TaskModel.findOneAndUpdate(
      { ...filter, createOperationId: { $type: 'string' } },
      {
        $set: {
          title: '[deleted]',
          description: '',
          urgent: false,
          important: false,
          lifecycleState: 'trashed',
          deletedAt: new Date(),
        },
        $unset: { priorLifecycleState: 1, delegation: 1 },
        $inc: { revision: 1 },
      },
      { returnDocument: 'before', runValidators: true }
    );
    const task = idempotentTask ?? (await TaskModel.findOneAndDelete(filter));
    return task ? toStoredTask(task.toObject() as PersistedTask) : null;
  }

  async exists(scope: TaskScope, id: string) {
    return Boolean(await TaskModel.exists({ _id: id, ...scope, deletedAt: { $exists: false } }));
  }
}
