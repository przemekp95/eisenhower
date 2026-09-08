import { connectApplicationRuntimes } from '../src/runtimeLifecycle';
import { DatabaseRuntime } from '../src/databaseRuntime';
import { RedisRateLimitRuntime } from '../src/redisRateLimit';

test('disconnects an already-connected database when Redis startup fails', async () => {
  const database = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseRuntime;
  const redis = {
    connect: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    disconnect: jest.fn().mockResolvedValue(undefined),
  } as unknown as RedisRateLimitRuntime;

  await expect(connectApplicationRuntimes(database, redis)).rejects.toThrow('redis unavailable');
  expect(redis.disconnect).toHaveBeenCalledTimes(1);
  expect(database.disconnect).toHaveBeenCalledTimes(1);
});

test('keeps connected runtimes open after successful startup', async () => {
  const database = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseRuntime;
  const redis = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  } as unknown as RedisRateLimitRuntime;

  await connectApplicationRuntimes(database, redis);
  expect(database.disconnect).not.toHaveBeenCalled();
  expect(redis.disconnect).not.toHaveBeenCalled();
});
