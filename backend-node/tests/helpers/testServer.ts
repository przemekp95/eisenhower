import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createApp, type CreateAppOptions } from '../../src/app';
import { connectToDatabase, disconnectFromDatabase } from '../../src/db';

export interface RunningTestServer {
  url: string;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export interface StartTestServerOptions {
  host?: string;
  port?: number;
  databaseName?: string;
  appOptions?: CreateAppOptions;
}

export async function startTestServer(options: StartTestServerOptions = {}): Promise<RunningTestServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const databaseName = options.databaseName ?? 'eisenhower-test';
  let mongo: MongoMemoryReplSet | null = null;
  let app: NestFastifyApplication | null = null;
  let closed = false;

  const cleanup = async () => {
    const errors: unknown[] = [];
    if (app) {
      try {
        await app.close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await disconnectFromDatabase();
    } catch (error) {
      errors.push(error);
    }
    if (mongo) {
      try {
        await mongo.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close every test server resource');
    }
  };

  let address: AddressInfo;
  try {
    mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
    });
    await connectToDatabase(mongo.getUri(databaseName));
    app = await createApp({
      aiHealthChecker: async () => 'healthy',
      ...options.appOptions,
    });
    await app.listen(port, host);
    const resolved = app.getHttpServer().address();
    if (!resolved || typeof resolved === 'string') {
      throw new Error('Failed to resolve test server address.');
    }
    address = resolved as AddressInfo;
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Test server startup and cleanup failed');
    }
    throw error;
  }

  return {
    url: `http://${host}:${address.port}`,
    reset: async () => {
      const collections = Object.values(mongoose.connection.collections);
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    },
    close: async () => {
      if (closed) {
        return;
      }

      closed = true;
      await cleanup();
    },
  };
}
