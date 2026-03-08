import mongoose from 'mongoose';

let activeUri: string | null = null;

export async function connectToDatabase(uri: string) {
  if (mongoose.connection.readyState === 1 && activeUri === uri) {
    return mongoose.connection;
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  await mongoose.connect(uri);
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
