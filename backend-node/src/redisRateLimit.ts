import { createClient } from 'redis';
import { RedisStore } from 'rate-limit-redis';
import type { Store } from 'express-rate-limit';

export interface RedisRateLimitRuntime {
  readonly store: Store;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): 'connected' | 'disconnected';
}

export function createRedisRateLimitRuntime(
  url: string,
  prefix = 'eisenhower:api:rate-limit:',
): RedisRateLimitRuntime {
  const client = createClient({
    url,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: (retries) => retries < 5 ? Math.min(100 * 2 ** retries, 2_000) : false,
    },
  });
  const store = new RedisStore({
    prefix,
    sendCommand: async (...args: string[]) => client.sendCommand(args) as Promise<string | number | boolean | (string | number | boolean)[]>,
  });
  return {
    store,
    connect: async () => { await client.connect(); },
    disconnect: async () => {
      if (client.isOpen) await client.quit();
    },
    status: () => client.isReady ? 'connected' : 'disconnected',
  };
}
