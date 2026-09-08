import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { connectToDatabase, disconnectFromDatabase, getDatabaseStatus } from './db';
import { PostgresConnectionSettings } from './config';
import { TaskRepository } from './application/taskRepository';
import { MongooseTaskRepository } from './repositories/mongooseTaskRepository';
import { PrismaTaskRepository } from './repositories/prismaTaskRepository';

export interface DatabaseRuntime {
  readonly taskRepository: TaskRepository;
  readonly calendarEnabled: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): 'connected' | 'disconnected';
}

export type DatabaseRuntimeOptions =
  | { provider: 'mongodb'; mongodbUri: string }
  | { provider: 'postgresql'; postgresqlUrl: string };

export function buildPostgresUrl(settings: PostgresConnectionSettings) {
  const username = encodeURIComponent(settings.username);
  const password = encodeURIComponent(settings.password);
  const database = encodeURIComponent(settings.database);
  return `postgresql://${username}:${password}@${settings.host}:${settings.port}/${database}?sslmode=${settings.ssl ? 'require' : 'disable'}`;
}

export function createDatabaseRuntime(options: DatabaseRuntimeOptions): DatabaseRuntime {
  if (options.provider === 'mongodb') {
    return {
      taskRepository: new MongooseTaskRepository(),
      calendarEnabled: true,
      connect: async () => { await connectToDatabase(options.mongodbUri); },
      disconnect: disconnectFromDatabase,
      status: getDatabaseStatus,
    };
  }

  const adapter = new PrismaPg({
    connectionString: options.postgresqlUrl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 20,
  });
  const prisma = new PrismaClient({ adapter });
  let connected = false;
  return {
    taskRepository: new PrismaTaskRepository(prisma),
    calendarEnabled: false,
    connect: async () => {
      await prisma.$connect();
      connected = true;
    },
    disconnect: async () => {
      await prisma.$disconnect();
      connected = false;
    },
    status: () => connected ? 'connected' : 'disconnected',
  };
}
