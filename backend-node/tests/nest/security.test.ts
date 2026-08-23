import { DynamicModule, Module, Controller, Get, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuditEvent, AuditSink } from '../../src/audit';
import { CreateAppOptions } from '../../src/app-options';
import { loadConfig } from '../../src/config';
import { createFastifyAdapter, registerFastifyPlatform } from '../../src/platform/http/fastify-platform';
import { HttpErrorFilter } from '../../src/platform/http/http-error.filter';
import { RequiredScopes } from '../../src/modules/security/security.decorators';
import { SecurityModule } from '../../src/modules/security/security.module';

@Controller('security-probe')
class SecurityProbeController {
  @Get()
  @RequiredScopes('tasks:read')
  read() {
    return { allowed: 'read' };
  }

  @Post()
  @RequiredScopes('tasks:write')
  write() {
    return { allowed: 'write' };
  }

  @Get('error')
  @RequiredScopes('tasks:read')
  error() {
    throw new Error('private database details');
  }
}

@Module({})
class SecurityProbeModule {
  static register(options: CreateAppOptions): DynamicModule {
    return {
      module: SecurityProbeModule,
      imports: [SecurityModule.register(options)],
      controllers: [SecurityProbeController],
    };
  }
}

describe('Nest Fastify HTTP security contract', () => {
  const applications: NestFastifyApplication[] = [];
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.AUTH_MODE = 'static';
    process.env.EISENHOWER_API_TOKEN = 'test-api-token';
    process.env.CORS_ALLOW_ORIGINS = 'https://tasks.example.com';
  });

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
  });

  async function create(options: CreateAppOptions = {}) {
    const config = loadConfig();
    const app = await NestFactory.create<NestFastifyApplication>(
      SecurityProbeModule.register(options),
      createFastifyAdapter(config.nodeEnv),
      { rawBody: true, logger: false },
    );
    await registerFastifyPlatform(app, config, options);
    app.useGlobalFilters(new HttpErrorFilter(config.nodeEnv === 'production'));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    applications.push(app);
    return app;
  }

  function useProductionEnvironment() {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER = 'https://identity.example.com';
    process.env.OIDC_AUDIENCE = 'eisenhower-api';
    process.env.OIDC_JWKS_URL = 'https://identity.example.com/.well-known/jwks.json';
    process.env.CORS_ALLOW_ORIGINS = 'https://tasks.example.com';
    process.env.MONGODB_URI = 'mongodb://mongodb:27017/eisenhower';
    process.env.AI_SERVICE_URL = 'http://ai-service:8000';
    process.env.AUDIT_LOG_PATH = '/tmp/eisenhower-nest-security-test.ndjson';
    process.env.AUDIT_HMAC_KEY = 'production-node-audit-key-at-least-32-bytes';
    process.env.RELEASE_SHA = 'a'.repeat(40);
  }

  it('preserves missing and invalid bearer responses, audit shape and request IDs', async () => {
    const events: AuditEvent[] = [];
    const app = await create({ auditSink: { record: (event) => { events.push(event); } } });

    const missing = await app.inject({ method: 'GET', url: '/security-probe' });
    const invalid = await app.inject({
      method: 'GET', url: '/security-probe',
      headers: { authorization: 'Bearer wrong-token', 'x-request-id': 'request-from-client' },
    });
    const malformedRequestId = await app.inject({
      method: 'GET', url: '/security-probe',
      headers: { authorization: 'Bearer wrong-token', 'x-request-id': 'bad request id' },
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    expect(missing.json()).toEqual({ error: 'Authentication required' });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(invalid.headers['x-request-id']).toBe('request-from-client');
    expect(invalid.json()).toEqual({ error: 'Invalid bearer token' });
    expect(malformedRequestId.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(events.map(({ action, outcome }) => ({ action, outcome }))).toEqual([
      { action: 'auth_rejection', outcome: 'rejected' },
      { action: 'auth_rejection', outcome: 'rejected' },
      { action: 'auth_rejection', outcome: 'rejected' },
    ]);
    expect(JSON.stringify(events)).not.toContain('wrong-token');
  });

  it('authenticates before Origin, enforces Origin, and fails closed when audit fails', async () => {
    const events: AuditEvent[] = [];
    const app = await create({ auditSink: { record: (event) => { events.push(event); } } });

    const unauthenticated = await app.inject({
      method: 'POST', url: '/security-probe',
      headers: { origin: 'https://attacker.example' }, payload: {},
    });
    const untrusted = await app.inject({
      method: 'POST', url: '/security-probe',
      headers: { authorization: 'Bearer test-api-token', origin: 'https://attacker.example' },
      payload: {},
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(untrusted.statusCode).toBe(403);
    expect(untrusted.json()).toEqual({ error: 'Untrusted browser origin' });
    expect(events.map(({ action }) => action)).toEqual(['auth_rejection', 'acl_rejection']);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const auditFailure: AuditSink = { record: () => { throw new Error('disk unavailable'); } };
    const failingApp = await create({ auditSink: auditFailure });
    const failed = await failingApp.inject({ method: 'GET', url: '/security-probe' });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: 'Security audit is unavailable' });
    expect(errorSpy).toHaveBeenCalledWith('backend-node required security audit write failed');
  });

  it('preserves OIDC verifier failures and endpoint scopes', async () => {
    process.env.AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER = 'https://identity.example.com';
    process.env.OIDC_AUDIENCE = 'eisenhower-api';
    process.env.OIDC_JWKS_URL = 'https://identity.example.com/.well-known/jwks.json';
    const app = await create({
      oidcTokenVerifier: async (token) => {
        if (token === 'invalid') throw new Error('bad token');
        return {
          tenantId: 'tenant-a', userId: 'user-a', roles: [], projectIds: [],
          scopes: token === 'read-only' ? ['tasks:read'] : ['tasks:write'],
        };
      },
    });

    const invalid = await app.inject({
      method: 'GET', url: '/security-probe', headers: { authorization: 'Bearer invalid' },
    });
    const allowed = await app.inject({
      method: 'GET', url: '/security-probe', headers: { authorization: 'Bearer read-only' },
    });
    const denied = await app.inject({
      method: 'POST', url: '/security-probe',
      headers: { authorization: 'Bearer read-only' }, payload: {},
    });

    expect(invalid.statusCode).toBe(401);
    expect(invalid.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(allowed.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({
      error: 'Required scope is missing', code: 'insufficient_scope',
    });
  });

  it('keeps CORS and Helmet single-owned and does not authenticate ambient cookies', async () => {
    const app = await create();
    const allowed = await app.inject({
      method: 'OPTIONS', url: '/security-probe',
      headers: {
        origin: 'https://tasks.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    const rejected = await app.inject({
      method: 'OPTIONS', url: '/security-probe',
      headers: { origin: 'https://attacker.example', 'access-control-request-method': 'GET' },
    });
    const cookieOnly = await app.inject({
      method: 'POST', url: '/security-probe',
      headers: { cookie: 'session=ambient', origin: 'https://tasks.example.com' }, payload: {},
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('https://tasks.example.com');
    expect(allowed.headers['access-control-allow-headers']).toContain('Authorization');
    expect(allowed.headers['access-control-allow-headers']).toContain('If-Match');
    expect(allowed.headers['access-control-expose-headers']).toContain('ETag');
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
    expect(cookieOnly.statusCode).toBe(401);
    expect(cookieOnly.headers['set-cookie']).toBeUndefined();
    expect(cookieOnly.headers['content-security-policy']).toBeDefined();
  });

  it('preserves the JSON body limit and production error redaction', async () => {
    const app = await create();
    const oversized = await app.inject({
      method: 'POST', url: '/security-probe',
      headers: { authorization: 'Bearer test-api-token', 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'x'.repeat(40_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toEqual({ error: 'Request body too large' });

    useProductionEnvironment();
    const production = await create({
      auditSink: { record: () => undefined },
      oidcTokenVerifier: async () => ({
        tenantId: 'tenant-a', userId: 'user-a', roles: [], projectIds: [], scopes: ['tasks:read'],
      }),
    });
    const failed = await production.inject({
      method: 'GET', url: '/security-probe/error',
      headers: { authorization: 'Bearer production-token' },
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: 'Internal server error' });
  });

  it('matches the Express rate-limit headers and text body', async () => {
    const app = await create({ rateLimitLimit: 1 });
    const first = await app.inject({
      method: 'GET', url: '/security-probe', headers: { authorization: 'Bearer test-api-token' },
    });
    const second = await app.inject({
      method: 'GET', url: '/security-probe', headers: { authorization: 'Bearer test-api-token' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.headers).toMatchObject({
      'ratelimit-policy': '1;w=60',
      'ratelimit-limit': '1',
      'ratelimit-remaining': '0',
      'retry-after': '60',
      'content-type': 'text/html; charset=utf-8',
    });
    expect(second.body).toBe('Too many requests, please try again later.');
  });

  it('trusts exactly one production proxy hop for the rate-limit identity', async () => {
    useProductionEnvironment();
    const app = await create({
      rateLimitLimit: 1,
      auditSink: { record: () => undefined },
      oidcTokenVerifier: async () => ({
        tenantId: 'tenant-a', userId: 'user-a', roles: [], projectIds: [], scopes: ['tasks:read'],
      }),
    });
    const headers = { authorization: 'Bearer token' };
    const firstClient = await app.inject({
      method: 'GET', url: '/security-probe', headers: { ...headers, 'x-forwarded-for': '198.51.100.10' },
    });
    const secondClient = await app.inject({
      method: 'GET', url: '/security-probe', headers: { ...headers, 'x-forwarded-for': '198.51.100.11' },
    });
    const spoofedFirstClient = await app.inject({
      method: 'GET', url: '/security-probe',
      headers: { ...headers, 'x-forwarded-for': '203.0.113.99, 198.51.100.10' },
    });

    expect(firstClient.statusCode).toBe(200);
    expect(secondClient.statusCode).toBe(200);
    expect(spoofedFirstClient.statusCode).toBe(429);
  });
});
