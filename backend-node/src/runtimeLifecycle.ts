import { DatabaseRuntime } from './databaseRuntime';
import { RedisRateLimitRuntime } from './redisRateLimit';

export async function connectApplicationRuntimes(
  database: DatabaseRuntime,
  redis?: RedisRateLimitRuntime,
): Promise<void> {
  let databaseConnected = false;
  try {
    await database.connect();
    databaseConnected = true;
    await redis?.connect();
  } catch (error) {
    await Promise.allSettled([
      redis?.disconnect() ?? Promise.resolve(),
      databaseConnected ? database.disconnect() : Promise.resolve(),
    ]);
    throw error;
  }
}
