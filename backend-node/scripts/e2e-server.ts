import { startTestServer } from '../tests/helpers/testServer';

const port = Number(process.env.PORT ?? '3101');
const host = process.env.HOST ?? '127.0.0.1';
const databaseName = process.env.E2E_MONGO_DB_NAME ?? 'eisenhower-e2e';

async function bootstrap() {
  const server = await startTestServer({
    host,
    port,
    databaseName,
  });
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[e2e-server] shutting down on ${signal}`);
    await server.close();
  };

  try {
    console.log(`[e2e-server] backend-node listening on ${server.url}`);

    const handleSignal = (signal: string) => {
      void shutdown(signal).finally(() => process.exit(0));
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
  } catch (error) {
    await shutdown('bootstrap failure');
    throw error;
  }
}

bootstrap().catch((error) => {
  console.error('[e2e-server] failed to start', error);
  process.exit(1);
});
