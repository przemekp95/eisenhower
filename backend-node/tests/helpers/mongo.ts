import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectToDatabase, disconnectFromDatabase } from '../../src/db';

let mongoServer: MongoMemoryReplSet | null = null;

export async function startMongo() {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = mongoServer.getUri();
  await connectToDatabase(uri);
  return uri;
}

export async function stopMongo() {
  await disconnectFromDatabase();
  if (mongoServer) {
    await mongoServer.stop();
    mongoServer = null;
  }
}

export async function clearMongo() {
  const collections = mongoose.connection.collections;
  for (const collection of Object.values(collections)) {
    await collection.deleteMany({});
  }
}
