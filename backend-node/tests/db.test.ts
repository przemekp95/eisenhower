import mongoose from 'mongoose';
import { connectToDatabase, disconnectFromDatabase, getDatabaseStatus } from '../src/db';
import { startMongo, stopMongo } from './helpers/mongo';

describe('database helpers', () => {
  let mongoUri: string;

  beforeAll(async () => {
    mongoUri = await startMongo();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await stopMongo();
  });

  it('reports connected when the database is online', () => {
    expect(getDatabaseStatus()).toBe('connected');
  });

  it('reports disconnected after disconnecting', async () => {
    await disconnectFromDatabase();

    expect(getDatabaseStatus()).toBe('disconnected');

    await connectToDatabase(mongoUri);
  });

  it('does nothing when disconnect is called without an active connection', async () => {
    const disconnectSpy = jest.spyOn(mongoose, 'disconnect');

    await disconnectFromDatabase();
    await disconnectFromDatabase();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);

    await connectToDatabase(mongoUri);
  });

  it('reuses active connection for the same uri', async () => {
    const connectSpy = jest.spyOn(mongoose, 'connect');
    const disconnectSpy = jest.spyOn(mongoose, 'disconnect');

    await connectToDatabase(mongoUri);
    await connectToDatabase(mongoUri);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  it('reconnects when switching to a different uri while already connected', async () => {
    const disconnectSpy = jest.spyOn(mongoose, 'disconnect');
    const connectSpy = jest.spyOn(mongoose, 'connect');
    const differentDatabaseUrl = new URL(mongoUri);
    differentDatabaseUrl.pathname = '/different-db';
    const differentUri = differentDatabaseUrl.toString();

    await connectToDatabase(differentUri);

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledWith(differentUri, expect.any(Object));

    await connectToDatabase(mongoUri);
  });

  it('uses bounded MongoDB timeouts and a bounded pool by default', async () => {
    await disconnectFromDatabase();
    const connectSpy = jest.spyOn(mongoose, 'connect');

    await connectToDatabase(mongoUri);

    expect(connectSpy).toHaveBeenCalledWith(mongoUri, {
      connectTimeoutMS: 5_000,
      serverSelectionTimeoutMS: 5_000,
      socketTimeoutMS: 10_000,
      maxPoolSize: 20,
      minPoolSize: 0,
      maxIdleTimeMS: 30_000,
    });
  });

  it('allows composition code to override MongoDB driver limits', async () => {
    await disconnectFromDatabase();
    const connectSpy = jest.spyOn(mongoose, 'connect');

    await connectToDatabase(mongoUri, { maxPoolSize: 7, socketTimeoutMS: 15_000 });

    expect(connectSpy).toHaveBeenCalledWith(mongoUri, expect.objectContaining({
      maxPoolSize: 7,
      socketTimeoutMS: 15_000,
      serverSelectionTimeoutMS: 5_000,
    }));
  });
});
