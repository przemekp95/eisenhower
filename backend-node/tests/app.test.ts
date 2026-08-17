import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app';
import { AuditEvent, AuditSink } from '../src/audit';
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
    delete process.env.MONGODB_URI;
    delete process.env.AI_SERVICE_URL;
    delete process.env.AUDIT_LOG_PATH;
    delete process.env.AUDIT_HMAC_KEY;
    delete process.env.RELEASE_SHA;
    delete process.env.CALENDAR_INTERNAL_HMAC_KEY;
    delete process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_CALENDAR_OAUTH_CALLBACK_URL;
    delete process.env.GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY;
    delete process.env.GOOGLE_CALENDAR_WATCH_CALLBACK_URLS;
  });

  it('rejects missing and invalid bearer credentials before protected routes', async () => {
    const events: AuditEvent[] = [];
    const auditSink: AuditSink = { record: (event) => { events.push(event); } };
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
      auditSink,
    });

    const missing = await request(app).get('/tasks');
    const invalid = await request(app)
      .get('/tasks')
      .set('X-Request-ID', 'request-from-client')
      .set('Authorization', 'Bearer wrong-token');

    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    expect(missing.body).toEqual({ error: 'Authentication required' });
    expect(invalid.status).toBe(401);
    expect(invalid.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(invalid.body).toEqual({ error: 'Invalid bearer token' });
    expect(events.map(({ action, outcome }) => ({ action, outcome }))).toEqual([
      { action: 'auth_rejection', outcome: 'rejected' },
      { action: 'auth_rejection', outcome: 'rejected' },
    ]);
    expect(JSON.stringify(events)).not.toContain('wrong-token');
    expect(events[1].requestId).toBe('request-from-client');
    expect(invalid.headers['x-request-id']).toBe('request-from-client');
  });

  it('fails closed when a required auth rejection cannot be audited', async () => {
    const auditSink: AuditSink = { record: () => { throw new Error('disk unavailable'); } };
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
      auditSink,
    });

    const response = await request(app).get('/tasks');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Security audit is unavailable' });
  });

  it('fails closed when invalid-token or Origin rejection audit is unavailable', async () => {
    process.env.CORS_ALLOW_ORIGINS = 'https://tasks.example.com';
    const auditSink: AuditSink = { record: () => { throw new Error('disk unavailable'); } };
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
      auditSink,
    });

    const invalid = await request(app).get('/tasks').set('Authorization', 'Bearer wrong');
    const origin = await request(app)
      .post('/tasks')
      .set('Authorization', 'Bearer test-api-token')
      .set('Origin', 'https://attacker.example')
      .send({ title: 'not persisted' });

    expect(invalid.status).toBe(503);
    expect(origin.status).toBe(503);
  });

  it('enforces explicit OIDC task scopes and audits denials without bearer data', async () => {
    process.env.AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER = 'https://identity.example.com';
    process.env.OIDC_AUDIENCE = 'eisenhower-api';
    process.env.OIDC_JWKS_URL = 'https://identity.example.com/.well-known/jwks.json';
    const events: AuditEvent[] = [];
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
      auditSink: { record: (event) => { events.push(event); } },
      oidcTokenVerifier: async (token) => ({
        tenantId: 'tenant-a',
        userId: 'user-a',
        roles: [],
        projectIds: [],
        scopes: token === 'read-only' ? ['tasks:read'] : ['tasks:write'],
      }),
    });

    const deniedRead = await request(app)
      .get('/tasks')
      .set('Authorization', 'Bearer write-only');
    const deniedHead = await request(app)
      .head('/tasks')
      .set('Authorization', 'Bearer write-only');
    const deniedMutation = await request(app)
      .post('/tasks')
      .set('Authorization', 'Bearer read-only')
      .send({ title: 'must not be persisted' });

    expect(deniedRead.status).toBe(403);
    expect(deniedHead.status).toBe(403);
    expect(deniedMutation.status).toBe(403);
    expect(deniedMutation.body).toEqual({
      error: 'Required scope is missing', code: 'insufficient_scope',
    });
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.action === 'acl_rejection')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('read-only');
    expect(JSON.stringify(events)).not.toContain('write-only');
  });

  it('fails closed when an OIDC task-scope rejection cannot be audited', async () => {
    process.env.AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER = 'https://identity.example.com';
    process.env.OIDC_AUDIENCE = 'eisenhower-api';
    process.env.OIDC_JWKS_URL = 'https://identity.example.com/.well-known/jwks.json';
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
      auditSink: { record: () => { throw new Error('disk unavailable'); } },
      oidcTokenVerifier: async () => ({
        tenantId: 'tenant-a', userId: 'user-a', roles: [], projectIds: [], scopes: ['tasks:read'],
      }),
    });

    const response = await request(app)
      .post('/tasks')
      .set('Authorization', 'Bearer read-only')
      .send({ title: 'must not be persisted' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Security audit is unavailable' });
  });

  it('rejects incomplete production audit identity configuration', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER = 'https://identity.example.com';
    process.env.OIDC_AUDIENCE = 'eisenhower-api';
    process.env.OIDC_JWKS_URL = 'https://identity.example.com/.well-known/jwks.json';
    process.env.CORS_ALLOW_ORIGINS = 'https://tasks.example.com';
    process.env.MONGODB_URI = 'mongodb://mongodb:27017/eisenhower';
    process.env.AI_SERVICE_URL = 'http://ai-service:8000';

    expect(() => createApp()).toThrow('AUDIT_LOG_PATH');

    process.env.AUDIT_LOG_PATH = '/tmp/eisenhower-node-audit-production-test.ndjson';
    process.env.AUDIT_HMAC_KEY = 'production-node-audit-key-at-least-32-bytes';
    expect(() => createApp()).toThrow('exact RELEASE_SHA');

    process.env.RELEASE_SHA = 'not-a-sha';
    expect(() => createApp()).toThrow('exact RELEASE_SHA');
  });

  it('rejects a weak internal calendar HMAC key', () => {
    expect(() => createApp({ calendarInternalHmacKey: 'too-short' }))
      .toThrow('CALENDAR_INTERNAL_HMAC_KEY must contain at least 32 bytes');
  });

  it('constructs default Google OAuth and Calendar HTTP adapters from configuration', () => {
    process.env.CALENDAR_INTERNAL_HMAC_KEY = 'configured-internal-calendar-key-at-least-32-bytes';
    process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID = 'client';
    process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_CALENDAR_OAUTH_CALLBACK_URL = 'https://tasks.example.com/calendar/oauth/callback';
    process.env.GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.GOOGLE_CALENDAR_WATCH_CALLBACK_URLS = 'https://hooks.example.com/google-calendar';

    expect(() => createApp()).not.toThrow();
  });

  it('authenticates before returning an authorization denial for browser origin', async () => {
    process.env.CORS_ALLOW_ORIGINS = 'https://tasks.example.com';
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app)
      .post('/tasks')
      .set('Origin', 'https://attacker.example')
      .send({ title: 'Cross-site task' });

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
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
    expect(ready.body).toEqual({
      status: 'ready',
      degraded: false,
      dependencies: { database: 'connected', ai: 'healthy' },
    });
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
    expect(allowed.headers['access-control-allow-headers']).toContain('If-Match');
    expect(allowed.headers['access-control-allow-headers']).toContain('Idempotency-Key');
    expect(allowed.headers['access-control-allow-headers']).toContain('X-Request-ID');
    expect(allowed.headers['access-control-expose-headers']).toContain('ETag');
    expect(allowed.headers['access-control-expose-headers']).toContain('X-Next-Cursor');
    expect(allowed.headers['access-control-expose-headers']).toContain('X-Request-ID');
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects state-changing browser requests from untrusted origins', async () => {
    const events: AuditEvent[] = [];
    process.env.CORS_ALLOW_ORIGINS = 'https://tasks.example.com';
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
      auditSink: { record: (event) => { events.push(event); } },
    });

    const response = await request(app)
      .post('/tasks')
      .set('Origin', 'https://attacker.example')
      .set('Authorization', 'Bearer test-api-token')
      .send({ title: 'Cross-site task', description: '', urgent: false, important: false });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Untrusted browser origin' });
    expect(events.at(-1)?.action).toBe('acl_rejection');
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
    process.env.AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER = 'https://identity.example.com';
    process.env.OIDC_AUDIENCE = 'eisenhower-api';
    process.env.OIDC_JWKS_URL = 'https://identity.example.com/.well-known/jwks.json';
    process.env.CORS_ALLOW_ORIGINS = 'https://tasks.example.com';
    process.env.MONGODB_URI = 'mongodb://mongodb:27017/eisenhower';
    process.env.AI_SERVICE_URL = 'http://ai-service:8000';
    process.env.AUDIT_LOG_PATH = '/tmp/eisenhower-node-audit-production-test.ndjson';
    process.env.AUDIT_HMAC_KEY = 'production-node-audit-key-at-least-32-bytes';
    process.env.RELEASE_SHA = 'a'.repeat(40);
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
      oidcTokenVerifier: async () => ({
        tenantId: 'tenant-a', userId: 'user-a', roles: [], projectIds: [], scopes: ['tasks:read'],
      }),
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
    process.env.MONGODB_URI = 'mongodb://mongodb:27017/eisenhower';
    process.env.AI_SERVICE_URL = 'http://ai-service:8000';
    process.env.AUDIT_LOG_PATH = '/tmp/eisenhower-node-audit-production-test.ndjson';
    process.env.AUDIT_HMAC_KEY = 'production-node-audit-key-at-least-32-bytes';
    process.env.RELEASE_SHA = 'a'.repeat(40);

    expect(() => createApp()).not.toThrow();
  });

  it('uses one trusted nginx hop for rate limiting and ignores a spoofed leftmost address', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER = 'https://identity.example.com';
    process.env.OIDC_AUDIENCE = 'eisenhower-api';
    process.env.OIDC_JWKS_URL = 'https://identity.example.com/.well-known/jwks.json';
    process.env.CORS_ALLOW_ORIGINS = 'https://tasks.example.com';
    process.env.MONGODB_URI = 'mongodb://mongodb:27017/eisenhower';
    process.env.AI_SERVICE_URL = 'http://ai-service:8000';
    process.env.AUDIT_LOG_PATH = '/tmp/eisenhower-node-audit-production-test.ndjson';
    process.env.AUDIT_HMAC_KEY = 'production-node-audit-key-at-least-32-bytes';
    process.env.RELEASE_SHA = 'a'.repeat(40);
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
      rateLimitLimit: 1,
    });

    const firstClient = await request(app).get('/health').set('X-Forwarded-For', '198.51.100.10');
    const secondClient = await request(app).get('/health').set('X-Forwarded-For', '198.51.100.11');
    const spoofedFirstClient = await request(app)
      .get('/health')
      .set('X-Forwarded-For', '203.0.113.99, 198.51.100.10');

    expect(firstClient.status).toBe(200);
    expect(secondClient.status).toBe(200);
    expect(spoofedFirstClient.status).toBe(429);
  });

  it('makes nginx overwrite rather than append untrusted forwarded addresses', () => {
    const nginxConfig = fs.readFileSync(
      path.resolve(__dirname, '../../web/nginx.conf'),
      'utf8',
    );

    expect(nginxConfig).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(nginxConfig).not.toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
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
