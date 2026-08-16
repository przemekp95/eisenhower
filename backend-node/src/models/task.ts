import { HydratedDocument, Model, Schema, model, models } from 'mongoose';
import type {
  TaskDelegation,
  TaskDelegationStatus,
  TaskLifecycleState,
  TaskSchedule,
} from '../application/taskRepository';

export interface Task {
  tenantId: string;
  ownerId: string;
  projectId?: string;
  title: string;
  description?: string;
  urgent: boolean;
  important: boolean;
  lifecycleState: TaskLifecycleState;
  schedule?: TaskSchedule;
  delegation?: TaskDelegation;
  priorLifecycleState?: Exclude<TaskLifecycleState, 'trashed'>;
  revision: number;
  createOperationId?: string;
  createOperationDigest?: string;
  deletedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type TaskDocument = HydratedDocument<Task>;
export type TaskModelType = Model<Task>;

const delegationSchema = new Schema<TaskDelegation>(
  {
    assigneeUserId: { type: String, required: true, trim: true, minlength: 1, maxlength: 128 },
    displayLabel: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    handoffNote: { type: String, trim: true, maxlength: 1000, default: '' },
    status: {
      type: String,
      enum: ['offered', 'accepted', 'in_progress', 'blocked', 'completed', 'declined'],
      required: true,
    },
    offeredAt: { type: Date, required: true },
    statusUpdatedAt: { type: Date, required: true },
    acceptedAt: { type: Date },
    inProgressAt: { type: Date },
    blockedAt: { type: Date },
    completedAt: { type: Date },
    declinedAt: { type: Date },
  },
  { _id: false }
);

const taskSchema = new Schema<Task>(
  {
    tenantId: { type: String, required: true, index: true, default: 'local' },
    ownerId: { type: String, required: true, index: true, default: 'local-user' },
    projectId: { type: String, index: true },
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },
    urgent: {
      type: Boolean,
      default: false,
    },
    important: {
      type: Boolean,
      default: false,
    },
    lifecycleState: {
      type: String,
      enum: ['active', 'completed', 'archived', 'trashed'],
      default: 'active',
      index: true,
    },
    priorLifecycleState: {
      type: String,
      enum: ['active', 'completed', 'archived'],
      select: false,
    },
    schedule: {
      type: new Schema<TaskSchedule>(
        {
          dueAt: { type: Date, required: true },
          timeZone: { type: String, required: true },
          remindAt: { type: Date },
        },
        { _id: false }
      ),
      required: false,
    },
    delegation: {
      type: delegationSchema,
      required: false,
    },
    createOperationId: {
      type: String,
      select: false,
    },
    createOperationDigest: {
      type: String,
      select: false,
    },
    deletedAt: {
      type: Date,
      select: false,
    },
  },
  {
    timestamps: true,
    versionKey: 'revision',
  }
);

taskSchema.index({ tenantId: 1, ownerId: 1, createdAt: -1, _id: -1 });
taskSchema.index({ tenantId: 1, ownerId: 1, lifecycleState: 1, createdAt: -1, _id: -1 });
taskSchema.index({
  tenantId: 1,
  'delegation.assigneeUserId': 1,
  'delegation.statusUpdatedAt': -1,
  _id: -1,
});
taskSchema.index(
  { tenantId: 1, ownerId: 1, createOperationId: 1 },
  {
    unique: true,
    partialFilterExpression: { createOperationId: { $type: 'string' } },
  }
);

taskSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const serialized = ret as unknown as {
      _id: string;
      createOperationId?: string;
      createOperationDigest?: string;
      deletedAt?: Date;
      priorLifecycleState?: TaskLifecycleState;
      delegation?: { status: TaskDelegationStatus };
    };
    serialized._id = String(ret._id);
    delete serialized.createOperationId;
    delete serialized.createOperationDigest;
    delete serialized.deletedAt;
    delete serialized.priorLifecycleState;
    return ret;
  },
});

export const TaskModel: TaskModelType =
  (models.Task as TaskModelType | undefined) ?? model<Task>('Task', taskSchema);
