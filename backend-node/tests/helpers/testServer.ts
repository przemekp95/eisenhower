import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
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

function waitForListen(server: Server, port: number, host: string) {
  return new Promise<AddressInfo>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off('listening', handleListening);
      reject(error);
    };

    const handleListening = () => {
      server.off('error', handleError);
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve test server address.'));
        return;
      }

      resolve(address);
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server) {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function startTestServer(options: StartTestServerOptions = {}): Promise<RunningTestServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const databaseName = options.databaseName ?? 'eisenhower-test';
  let mongo: MongoMemoryServer | null = null;
  let server: Server | null = null;
  let closed = false;

  const cleanup = async () => {
    const errors: unknown[] = [];
    if (server) {
      try {
        await closeServer(server);
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
    mongo = await MongoMemoryServer.create({
      instance: {
        dbName: databaseName,
      },
    });
    await connectToDatabase(mongo.getUri());
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      ...options.appOptions,
    });
    server = createServer(app);
    address = await waitForListen(server, port, host);
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
