import request from 'supertest';
import { createApp } from '../src/app';
import { TaskModel } from '../src/models/task';

describe('app middleware', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.EISENHOWER_API_TOKEN = 'test-api-token';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.EISENHOWER_API_TOKEN;
    delete process.env.AUTH_MODE;
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_AUDIENCE;
    delete process.env.OIDC_JWKS_URL;
    delete process.env.CORS_ALLOW_ORIGINS;
  });

  it('rejects missing and invalid bearer credentials before protected routes', async () => {
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const missing = await request(app).get('/tasks');
    const invalid = await request(app)
      .get('/tasks')
      .set('Authorization', 'Bearer wrong-token');

    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    expect(missing.body).toEqual({ error: 'Authentication required' });
    expect(invalid.status).toBe(403);
    expect(invalid.body).toEqual({ error: 'Access denied' });
  });

  it('keeps health public and opaque', async () => {
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const live = await request(app).get('/health');
    const ready = await request(app).get('/health/ready');

    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready' });
  });

  it('allows only configured browser origins and authorization headers', async () => {
    process.env.CORS_ALLOW_ORIGINS = 'https://tasks.example.com';
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const allowed = await request(app).options('/tasks').set({
      Origin: 'https://tasks.example.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    });
    const rejected = await request(app).options('/tasks').set({
      Origin: 'https://attacker.example',
      'Access-Control-Request-Method': 'GET',
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('https://tasks.example.com');
    expect(allowed.headers['access-control-allow-headers']).toContain('Authorization');
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects state-changing browser requests from untrusted origins', async () => {
    process.env.CORS_ALLOW_ORIGINS = 'https://tasks.example.com';
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app)
      .post('/tasks')
      .set('Origin', 'https://attacker.example')
      .set('Authorization', 'Bearer test-api-token')
      .send({ title: 'Cross-site task', description: '', urgent: false, important: false });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Untrusted browser origin' });
  });

  it('rejects oversized JSON bodies', async () => {
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app)
      .post('/tasks')
      .set('Authorization', 'Bearer test-api-token')
      .send({ title: 'x'.repeat(40_000) });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'Request body too large' });
  });

  it('logs non-health requests without query strings', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app)
      .get('/missing?from=test')
      .set('Authorization', 'Bearer test-api-token');

    expect(response.status).toBe(404);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/^backend-node GET \/missing 404 \d+ms$/));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs server errors for failing non-health routes', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(TaskModel, 'find').mockReturnValue({
      sort: () => ({
        lean: async () => {
          throw new Error('list failure');
        },
      }),
    } as never);

    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app)
      .get('/tasks')
      .set('Authorization', 'Bearer test-api-token');

    expect(response.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^backend-node GET \/tasks 500 \d+ms$/));
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('does not expose exception details in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'static';
    process.env.EISENHOWER_API_TOKEN = 'production-api-token-at-least-32-characters';
    process.env.CORS_ALLOW_ORIGINS = 'https://tasks.example.com';
    jest.spyOn(TaskModel, 'find').mockReturnValue({
      sort: () => ({
        lean: async () => {
          throw new Error('database internals');
        },
      }),
    } as never);
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app)
      .get('/tasks')
      .set('Authorization', 'Bearer production-api-token-at-least-32-characters');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });

  it('constructs the OIDC middleware for a valid production configuration', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER = 'https://identity.example.com';
    process.env.OIDC_AUDIENCE = 'eisenhower-api';
    process.env.OIDC_JWKS_URL = 'https://identity.example.com/.well-known/jwks.json';
    process.env.CORS_ALLOW_ORIGINS = 'https://tasks.example.com';

    expect(() => createApp()).not.toThrow();
  });

  it('skips request logging for health checks', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('skips request logging for readiness checks', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('skips request logging for OPTIONS preflight requests', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).options('/tasks');

    expect(response.status).toBe(204);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
