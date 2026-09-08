import Redis from 'ioredis';

export interface RedisRateLimitRuntime {
  readonly client: Redis;
  readonly nameSpace: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): 'connected' | 'disconnected';
}

export function createRedisRateLimitRuntime(
  url: string,
  prefix = 'eisenhower:api:rate-limit:',
): RedisRateLimitRuntime {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (retries) => retries < 5 ? Math.min(100 * 2 ** retries, 2_000) : null,
  });
  return {
    client,
    nameSpace: prefix,
    connect: async () => { await client.connect(); },
    disconnect: async () => {
      if (client.status !== 'end') await client.quit();
    },
    status: () => client.status === 'ready' ? 'connected' : 'disconnected',
  };
}
