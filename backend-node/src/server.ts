import { Server } from 'node:http';
import { createApp } from './app';
import { loadConfig } from './config';
import { connectToDatabase, disconnectFromDatabase } from './db';

let server: Server | null = null;
let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down backend-node`);

  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  } catch (error) {
    console.error('Failed to close backend-node HTTP server', error);
    process.exitCode = 1;
  }

  try {
    await disconnectFromDatabase();
  } catch (error) {
    console.error('Failed to disconnect backend-node from MongoDB', error);
    process.exitCode = 1;
  }

  process.exit(process.exitCode ?? 0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

async function bootstrap() {
  const config = loadConfig();
  await connectToDatabase(config.mongodbUri);

  const app = createApp();
  server = app.listen(config.port, () => {
    console.log(`backend-node listening on ${config.port}`);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start backend-node', error);
  process.exit(1);
});
