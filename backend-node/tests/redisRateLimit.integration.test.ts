import request from 'supertest';
import { createApp } from '../src/app';
import { createRedisRateLimitRuntime } from '../src/redisRateLimit';

const redisUrl = process.env.REDIS_TEST_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('shared Redis rate limiting', () => {
  it('enforces one counter across two independent API instances', async () => {
    const prefix = `eisenhower:test:${Date.now()}:`;
    const firstRuntime = createRedisRateLimitRuntime(redisUrl!, prefix);
    const secondRuntime = createRedisRateLimitRuntime(redisUrl!, prefix);
    await Promise.all([firstRuntime.connect(), secondRuntime.connect()]);
    try {
      const firstApp = createApp({
        rateLimitLimit: 1,
        rateLimitStore: firstRuntime.store,
        aiHealthChecker: async () => 'healthy',
        databaseStatusResolver: () => 'connected',
      });
      const secondApp = createApp({
        rateLimitLimit: 1,
        rateLimitStore: secondRuntime.store,
        aiHealthChecker: async () => 'healthy',
        databaseStatusResolver: () => 'connected',
      });

      await expect(request(firstApp).get('/health')).resolves.toMatchObject({ status: 200 });
      const rejected = await request(secondApp).get('/health');
      expect(rejected.status).toBe(429);
      expect(rejected.headers['ratelimit-remaining']).toBe('0');
    } finally {
      await Promise.all([firstRuntime.disconnect(), secondRuntime.disconnect()]);
    }
  });
});
