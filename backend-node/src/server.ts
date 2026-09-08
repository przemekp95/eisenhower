import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createAppFromConfig } from './app';
import { loadConfig } from './config';
import { buildPostgresUrl, createDatabaseRuntime, DatabaseRuntime } from './databaseRuntime';
import { createRedisRateLimitRuntime, RedisRateLimitRuntime } from './redisRateLimit';
import { connectApplicationRuntimes } from './runtimeLifecycle';

let app: NestFastifyApplication | null = null;
let isShuttingDown = false;
let databaseRuntime: DatabaseRuntime | null = null;
let redisRuntime: RedisRateLimitRuntime | null = null;

async function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down backend-node`);
  try {
    await app?.close();
  } catch (error) {
    console.error('Failed to close backend-node HTTP server', error);
    process.exitCode = 1;
  }
  try {
    await redisRuntime?.disconnect();
    await databaseRuntime?.disconnect();
  } catch (error) {
    console.error('Failed to disconnect backend-node runtimes', error);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown(signal); });
}

async function bootstrap() {
  const config = loadConfig();
  databaseRuntime = config.databaseProvider === 'postgresql'
    ? createDatabaseRuntime({ provider: 'postgresql', postgresqlUrl: buildPostgresUrl(config.postgresql!) })
    : createDatabaseRuntime({ provider: 'mongodb', mongodbUri: config.mongodbUri });
  if (config.redisUrl) redisRuntime = createRedisRateLimitRuntime(config.redisUrl);
  await connectApplicationRuntimes(databaseRuntime, redisRuntime ?? undefined);
  app = await createAppFromConfig({
    taskRepository: databaseRuntime.taskRepository,
    databaseStatusResolver: databaseRuntime.status,
    ...(redisRuntime ? {
      rateLimitRedis: redisRuntime.client,
      rateLimitNameSpace: redisRuntime.nameSpace,
      redisStatusResolver: redisRuntime.status,
    } : {}),
    calendarEnabled: databaseRuntime.calendarEnabled,
  }, config);
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`backend-node listening on ${config.port}`);
}

bootstrap().catch((error) => {
  console.error('Failed to start backend-node', error);
  process.exit(1);
});
