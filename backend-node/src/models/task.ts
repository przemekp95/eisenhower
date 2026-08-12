import { HydratedDocument, Model, Schema, model, models } from 'mongoose';

export interface Task {
  tenantId: string;
  ownerId: string;
  projectId?: string;
  title: string;
  description?: string;
  urgent: boolean;
  important: boolean;
  revision: number;
  createOperationId?: string;
  createOperationDigest?: string;
  deletedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type TaskDocument = HydratedDocument<Task>;
export type TaskModelType = Model<Task>;

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
taskSchema.index(
  { tenantId: 1, ownerId: 1, createOperationId: 1 },
  {
    unique: true,
    partialFilterExpression: { createOperationId: { $type: 'string' } },
  },
);

taskSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const serialized = ret as unknown as {
      _id: string;
      createOperationId?: string;
      createOperationDigest?: string;
      deletedAt?: Date;
    };
    serialized._id = String(ret._id);
    delete serialized.createOperationId;
    delete serialized.createOperationDigest;
    delete serialized.deletedAt;
    return ret;
  },
});

export const TaskModel: TaskModelType =
  (models.Task as TaskModelType | undefined) ?? model<Task>('Task', taskSchema);
