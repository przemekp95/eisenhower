import {
  After,
  AfterAll,
  Before,
  BeforeAll,
  IWorldOptions,
  setDefaultTimeout,
  setWorldConstructor,
  World,
} from '@cucumber/cucumber';
import type { Response } from '../../tests/helpers/http-test-client';
import { createApp } from '../../src/app';
import { clearMongo, startMongo, stopMongo } from '../../tests/helpers/mongo';

setDefaultTimeout(30_000);

const environmentKeys = [
  'NODE_ENV',
  'AUTH_MODE',
  'EISENHOWER_API_TOKEN',
  'CORS_ALLOW_ORIGINS',
  'OIDC_ISSUER',
  'OIDC_AUDIENCE',
  'OIDC_JWKS_URL',
] as const;
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof environmentKeys)[number], string | undefined>;

function configureTestEnvironment() {
  process.env.NODE_ENV = 'test';
  process.env.AUTH_MODE = 'static';
  process.env.EISENHOWER_API_TOKEN = 'test-api-token';
  delete process.env.CORS_ALLOW_ORIGINS;
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_AUDIENCE;
  delete process.env.OIDC_JWKS_URL;
}

function restoreEnvironment() {
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export class EisenhowerWorld extends World {
  app!: ReturnType<typeof createApp>;
  response?: Response;
  taskId?: string;
  taskRevision?: number;
  actorTenantId = 'local';
  actorUserId = 'local-user';

  constructor(options: IWorldOptions) {
    super(options);
  }
}

setWorldConstructor(EisenhowerWorld);

BeforeAll(async () => {
  await startMongo();
});

Before(function (this: EisenhowerWorld) {
  configureTestEnvironment();
  this.app = createApp({
    aiHealthChecker: async () => 'healthy',
    databaseStatusResolver: () => 'connected',
    auditSink: { record: () => undefined },
    oidcTokenVerifier: async (token) => {
      if (token !== 'test-api-token' && !token.includes(':')) throw new Error('invalid token');
      const [tenantId, userId] = token === 'test-api-token'
        ? ['local', 'local-user']
        : token.split(':');
      return {
        tenantId, userId, roles: ['user'], projectIds: [],
        scopes: ['tasks:read', 'tasks:write'],
      };
    },
  });
  this.response = undefined;
  this.taskId = undefined;
  this.taskRevision = undefined;
  this.actorTenantId = 'local';
  this.actorUserId = 'local-user';
});

After(async function (this: EisenhowerWorld) {
  await (await this.app).close();
  await clearMongo();
});

AfterAll(async () => {
  await stopMongo();
  restoreEnvironment();
});
