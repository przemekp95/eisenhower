import mongoose from 'mongoose';
import { TaskModel } from './models/task';
import {
  CalendarBindingModel,
  CalendarConflictModel,
  CalendarConnectionModel,
  CalendarDomainAuditModel,
  CalendarMutationReceiptModel,
  CalendarOutboxModel,
  CalendarSyncStateModel,
  GoogleOAuthAttemptModel,
  GoogleOAuthGrantModel,
} from './models/calendar';

let activeUri: string | null = null;

export type MongoConnectionOptions = Pick<
  mongoose.ConnectOptions,
  | 'connectTimeoutMS'
  | 'serverSelectionTimeoutMS'
  | 'socketTimeoutMS'
  | 'maxPoolSize'
  | 'minPoolSize'
  | 'maxIdleTimeMS'
>;

const DEFAULT_MONGO_CONNECTION_OPTIONS: MongoConnectionOptions = {
  connectTimeoutMS: 5_000,
  serverSelectionTimeoutMS: 5_000,
  socketTimeoutMS: 10_000,
  maxPoolSize: 20,
  minPoolSize: 0,
  maxIdleTimeMS: 30_000,
};

export async function connectToDatabase(uri: string, options: MongoConnectionOptions = {}) {
  if (mongoose.connection.readyState === 1 && activeUri === uri) {
    return mongoose.connection;
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  await mongoose.connect(uri, { ...DEFAULT_MONGO_CONNECTION_OPTIONS, ...options });
  await TaskModel.init();
  await Promise.all([
    CalendarConnectionModel.init(),
    CalendarBindingModel.init(),
    CalendarConflictModel.init(),
    CalendarSyncStateModel.init(),
    CalendarOutboxModel.init(),
    CalendarMutationReceiptModel.init(),
    CalendarDomainAuditModel.init(),
    GoogleOAuthAttemptModel.init(),
    GoogleOAuthGrantModel.init(),
  ]);
  activeUri = uri;
  return mongoose.connection;
}

export async function disconnectFromDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  activeUri = null;
}

export function getDatabaseStatus(): 'connected' | 'disconnected' {
  return mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
}
