import { HydratedDocument, Model, Schema, model, models } from 'mongoose';

export interface Task {
  tenantId: string;
  ownerId: string;
  projectId?: string;
  title: string;
  description?: string;
  urgent: boolean;
  important: boolean;
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
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

taskSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const serialized = ret as unknown as { _id: string };
    serialized._id = String(ret._id);
    return ret;
  },
});

export const TaskModel: TaskModelType =
  (models.Task as TaskModelType | undefined) ?? model<Task>('Task', taskSchema);
