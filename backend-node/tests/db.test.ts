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

  it('reuses active connection for the same uri', async () => {
    const connectSpy = jest.spyOn(mongoose, 'connect');
    const disconnectSpy = jest.spyOn(mongoose, 'disconnect');

    await connectToDatabase(mongoUri);
    await connectToDatabase(mongoUri);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(disconnectSpy).not.toHaveBeenCalled();
  });
});
