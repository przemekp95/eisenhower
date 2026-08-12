import type { QueryFilter } from 'mongoose';
import {
  CreateOperation,
  CreateTaskPersistenceResult,
  StoredTask,
  TaskPageCursor,
  TaskPayload,
  TaskRepository,
  TaskScope,
} from '../application/taskRepository';
import { Task, TaskModel } from '../models/task';

type PersistedTask = Task & {
  _id: unknown;
  createOperationDigest?: string;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

function revisionFilter(expectedRevision: number) {
  if (expectedRevision === 0) {
    return { $or: [{ revision: 0 }, { revision: { $exists: false } }] };
  }
  return { revision: expectedRevision };
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
    revision: task.revision ?? 0,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export class MongooseTaskRepository implements TaskRepository {
  async listPage(scope: TaskScope, limit: number, cursor?: TaskPageCursor) {
    const activeScope = { ...scope, deletedAt: { $exists: false } };
    const filter: QueryFilter<Task> = cursor ? {
      ...activeScope,
      $or: [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
      ],
    } : activeScope;
    const page = await TaskModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasNextPage = page.length > limit;
    return {
      tasks: (hasNextPage ? page.slice(0, limit) : page).map((task) => toStoredTask(task as PersistedTask)),
      hasNextPage,
    };
  }

  async create(
    scope: TaskScope,
    payload: TaskPayload,
    operation?: CreateOperation,
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
      { upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    const task = await TaskModel.findOne({ ...scope, createOperationId: operation.id })
      .select('+createOperationDigest +deletedAt')
      .lean() as PersistedTask | null;
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
    patch: Partial<TaskPayload>,
  ) {
    const task = await TaskModel.findOneAndUpdate(
      { _id: id, ...scope, deletedAt: { $exists: false }, ...revisionFilter(expectedRevision) },
      { $set: patch, $inc: { revision: 1 } },
      { returnDocument: 'after', runValidators: true },
    );
    return task ? toStoredTask(task.toObject() as PersistedTask) : null;
  }

  async delete(scope: TaskScope, id: string, expectedRevision: number) {
    const filter = {
      _id: id,
      ...scope,
      deletedAt: { $exists: false },
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
          deletedAt: new Date(),
        },
        $inc: { revision: 1 },
      },
      { returnDocument: 'before', runValidators: true },
    );
    const task = idempotentTask ?? await TaskModel.findOneAndDelete(filter);
    return task ? toStoredTask(task.toObject() as PersistedTask) : null;
  }

  async exists(scope: TaskScope, id: string) {
    return Boolean(await TaskModel.exists({ _id: id, ...scope, deletedAt: { $exists: false } }));
  }
}
