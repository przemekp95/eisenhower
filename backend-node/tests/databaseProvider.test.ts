import request from './helpers/http-test-client';
import { loadConfig } from '../src/config';
import { createApp } from '../src/app';
import { buildPostgresUrl, createDatabaseRuntime } from '../src/databaseRuntime';
import { PrismaTaskRepository } from '../src/repositories/prismaTaskRepository';
import * as dbModule from '../src/db';

const productionBase = {
  NODE_ENV: 'production',
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'https://identity.example.com',
  OIDC_AUDIENCE: 'eisenhower-api',
  OIDC_JWKS_URL: 'https://identity.example.com/jwks',
  AI_SERVICE_URL: 'https://ai.example.com',
  CORS_ALLOW_ORIGINS: 'https://app.example.com',
  AUDIT_LOG_PATH: '/tmp/audit.ndjson',
  AUDIT_HMAC_KEY: 'b'.repeat(32),
  RELEASE_SHA: 'c'.repeat(40),
};

describe('database provider configuration', () => {
  it('requires complete PostgreSQL settings and URL-encodes credentials', () => {
    const env = {
      ...productionBase,
      DATABASE_PROVIDER: 'postgresql',
      DATABASE_HOST: 'db.internal',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'eisenhower',
      DATABASE_USERNAME: 'api user',
      DATABASE_PASSWORD: 'p@ss:/word',
    };
    const config = loadConfig(env);
    expect(config.databaseProvider).toBe('postgresql');
    expect(buildPostgresUrl(config.postgresql!)).toBe(
      'postgresql://api%20user:p%40ss%3A%2Fword@db.internal:5432/eisenhower?sslmode=require'
    );
  });

  it('fails closed when PostgreSQL production settings are incomplete', () => {
    expect(() => loadConfig({ ...productionBase, DATABASE_PROVIDER: 'postgresql' })).toThrow(
      'DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USERNAME and DATABASE_PASSWORD are required'
    );
  });

  it('constructs the selected repository without connecting during import', () => {
    const runtime = createDatabaseRuntime({
      provider: 'postgresql',
      postgresqlUrl: 'postgresql://user:password@127.0.0.1:1/eisenhower?sslmode=require',
    });
    expect(runtime.taskRepository).toBeInstanceOf(PrismaTaskRepository);
    expect(runtime.status()).toBe('disconnected');
  });

  it('delegates the MongoDB runtime lifecycle and status to the established database adapter', async () => {
    const connect = jest.spyOn(dbModule, 'connectToDatabase').mockResolvedValue({} as never);
    const disconnect = jest.spyOn(dbModule, 'disconnectFromDatabase').mockResolvedValue(undefined);
    const status = jest.spyOn(dbModule, 'getDatabaseStatus').mockReturnValue('connected');
    const runtime = createDatabaseRuntime({
      provider: 'mongodb',
      mongodbUri: 'mongodb://mongo.internal/eisenhower',
    });

    await runtime.connect();
    expect(connect).toHaveBeenCalledWith('mongodb://mongo.internal/eisenhower');
    expect(runtime.status()).toBe('connected');
    expect(status).toHaveBeenCalledTimes(1);
    await runtime.disconnect();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('keeps Mongo-dependent Calendar routes unavailable in PostgreSQL mode', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({
      calendarEnabled: false,
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });
    const response = await request(app)
      .get('/calendar')
      .set('Authorization', 'Bearer test-api-token');
    expect(response.status).toBe(404);
  });

  it('builds authenticated TLS Redis settings only when explicitly enabled', () => {
    const config = loadConfig({
      ...productionBase,
      MONGODB_URI: 'mongodb://mongo.internal/eisenhower',
      REDIS_ENABLED: 'true',
      REDIS_HOST: 'cache.internal',
      REDIS_PORT: '6379',
      REDIS_AUTH_TOKEN: 'token with:/symbols',
      REDIS_TLS: 'true',
    });
    expect(config.redisUrl).toBe(
      'rediss://:token%20with%3A%2Fsymbols@cache.internal:6379'
    );
  });

  it('makes required Redis part of readiness', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({
      redisStatusResolver: () => 'disconnected',
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });
    const response = await request(app).get('/health/ready');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'not_ready',
      degraded: true,
      dependencies: { database: 'connected', ai: 'healthy', redis: 'disconnected' },
    });
  });
});
