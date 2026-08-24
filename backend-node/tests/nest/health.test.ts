import { createApp as createNestApp } from '../../src/app';

describe('Nest Fastify health transport', () => {
  const applications: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
  });

  async function create(options: Parameters<typeof createNestApp>[0] = {}) {
    const app = await createNestApp(options);
    applications.push(app);
    return app;
  }

  it('preserves liveness and ready health bodies through the real Fastify adapter', async () => {
    const app = await create({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const live = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    expect({ status: live.statusCode, body: live.json() }).toEqual({
      status: 200,
      body: { status: 'ok' },
    });
    expect({ status: ready.statusCode, body: ready.json() }).toEqual({
      status: 200,
      body: {
        status: 'ready',
        degraded: false,
        dependencies: { database: 'connected', ai: 'healthy' },
      },
    });
  });

  it.each([
    {
      name: 'AI reports unhealthy',
      aiHealthChecker: async () => 'unhealthy' as const,
      databaseStatusResolver: (): 'connected' => 'connected',
      status: 200,
      body: {
        status: 'ready', degraded: true,
        dependencies: { database: 'connected', ai: 'unhealthy' },
      },
    },
    {
      name: 'database is disconnected',
      aiHealthChecker: async () => 'healthy' as const,
      databaseStatusResolver: (): 'disconnected' => 'disconnected',
      status: 503,
      body: {
        status: 'not_ready', degraded: true,
        dependencies: { database: 'disconnected', ai: 'healthy' },
      },
    },
    {
      name: 'AI checker throws',
      aiHealthChecker: async () => { throw new Error('AI unavailable'); },
      databaseStatusResolver: (): 'connected' => 'connected',
      status: 200,
      body: {
        status: 'ready', degraded: true,
        dependencies: { database: 'connected', ai: 'unreachable' },
      },
    },
  ])('preserves readiness when $name', async ({
    aiHealthChecker, databaseStatusResolver, status, body,
  }) => {
    const app = await create({ aiHealthChecker, databaseStatusResolver });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect({ status: response.statusCode, body: response.json() }).toEqual({ status, body });
  });

  it('maps an unknown route to the existing JSON contract', async () => {
    const app = await create();

    const response = await app.inject({ method: 'GET', url: '/unknown' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Route not found' });
  });
});
