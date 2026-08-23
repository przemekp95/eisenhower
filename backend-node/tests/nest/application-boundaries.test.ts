import type { AuthPrincipal } from '../../src/auth';
import type { AppConfig } from '../../src/config';
import type { TaskRepository } from '../../src/application/taskRepository';
import { TaskCommandService } from '../../src/application/tasks/task-command.service';
import {
  MAX_TASK_PAGE_LIMIT, TaskQueryService,
} from '../../src/application/tasks/task-query.service';
import { InternalHmacService } from '../../src/modules/calendar-internal/internal-hmac.service';
import { AuditService } from '../../src/modules/security/audit.service';

const principal: AuthPrincipal = {
  tenantId: 'tenant-a', userId: 'user-a', roles: [], projectIds: [], scopes: [],
};

const repository = {} as TaskRepository;

describe('application boundary validation', () => {
  it('rejects an invalid task id even when the transport validation is bypassed', async () => {
    const service = new TaskCommandService(repository);

    await expect(service.update(principal, 'invalid', 1, {})).rejects.toMatchObject({
      status: 400,
      body: { error: 'Validation failed', details: ['Invalid value'] },
    });
  });

  it.each([0, 1.5, MAX_TASK_PAGE_LIMIT + 1])(
    'rejects owned-list limit %s below the HTTP transport',
    async (limit) => {
      const service = new TaskQueryService(repository);

      await expect(service.listOwned(principal, { limit, lifecycle: 'active' }))
        .rejects.toMatchObject({
          status: 400, body: { error: 'limit must be an integer from 1 to 200' },
        });
    },
  );

  it.each([0, 1.5, MAX_TASK_PAGE_LIMIT + 1])(
    'rejects delegated-list limit %s below the HTTP transport',
    async (limit) => {
      const service = new TaskQueryService(repository);

      await expect(service.listDelegated(principal, { limit, lifecycle: 'active' }))
        .rejects.toMatchObject({
          status: 400, body: { error: 'limit must be an integer from 1 to 200' },
        });
    },
  );

  it('rejects a non-string lifecycle below the HTTP transport', async () => {
    const service = new TaskQueryService(repository);

    await expect(service.listOwned(principal, {
      limit: 1,
      lifecycle: null as unknown as 'active',
    })).rejects.toMatchObject({ status: 400, body: { error: 'Invalid lifecycle filter' } });
  });

  it('rejects a weak internal HMAC key at the service boundary', () => {
    expect(() => new InternalHmacService('too-short'))
      .toThrow('CALENDAR_INTERNAL_HMAC_KEY must contain at least 32 bytes');
  });

  it('treats completion without an internal request context as a no-op', async () => {
    const service = new InternalHmacService('a'.repeat(32));

    await expect(service.complete(undefined, 204)).resolves.toBeUndefined();
  });

  it('rejects incomplete production audit configuration at the service boundary', () => {
    const config: AppConfig = {
      port: 3001,
      mongodbUri: 'mongodb://localhost:27017/eisenhower',
      aiServiceUrl: 'http://localhost:8000',
      nodeEnv: 'production',
      authMode: 'oidc',
      apiToken: '',
      oidcIssuer: 'https://identity.example.com',
      oidcAudience: 'eisenhower-api',
      oidcJwksUrl: 'https://identity.example.com/.well-known/jwks.json',
      corsAllowOrigins: ['https://tasks.example.com'],
    };
    const previous = {
      path: process.env.AUDIT_LOG_PATH,
      key: process.env.AUDIT_HMAC_KEY,
      sha: process.env.RELEASE_SHA,
    };
    delete process.env.AUDIT_LOG_PATH;
    delete process.env.AUDIT_HMAC_KEY;
    delete process.env.RELEASE_SHA;
    try {
      expect(() => new AuditService({}, config)).toThrow('AUDIT_LOG_PATH');
    } finally {
      if (previous.path === undefined) delete process.env.AUDIT_LOG_PATH;
      else process.env.AUDIT_LOG_PATH = previous.path;
      if (previous.key === undefined) delete process.env.AUDIT_HMAC_KEY;
      else process.env.AUDIT_HMAC_KEY = previous.key;
      if (previous.sha === undefined) delete process.env.RELEASE_SHA;
      else process.env.RELEASE_SHA = previous.sha;
    }
  });
});
