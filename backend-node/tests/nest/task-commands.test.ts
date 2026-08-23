import { createApp as createNestApp } from '../../src/app';
import { TaskModel } from '../../src/models/task';
import { clearMongo, startMongo, stopMongo } from '../helpers/mongo';

describe('Nest Fastify task commands', () => {
  const originalEnvironment = { ...process.env };
  let app: Awaited<ReturnType<typeof createNestApp>>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER = 'https://identity.example.com';
    process.env.OIDC_AUDIENCE = 'eisenhower-api';
    process.env.OIDC_JWKS_URL = 'https://identity.example.com/.well-known/jwks.json';
    await startMongo();
    app = await createNestApp({
      auditSink: { record: () => undefined },
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
      oidcTokenVerifier: async (token) => {
        const [tenantId, userId] = token.split(':');
        return {
          tenantId, userId, roles: ['user'], projectIds: [],
          scopes: ['tasks:read', 'tasks:write'],
        };
      },
    });
  });

  afterEach(clearMongo);

  afterAll(async () => {
    await app.close();
    await stopMongo();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
  });

  function request(
    method: 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
    principal = 'tenant-a:owner-a',
  ) {
    return app.inject({
      method, url,
      headers: { authorization: `Bearer ${principal}`, ...headers },
      ...(payload === undefined ? {} : { payload: payload as string | object }),
    });
  }

  it('creates, trims and replays a task with exact ETag/idempotency headers', async () => {
    const first = await request('POST', '/tasks', {
      title: '  Retry-safe task  ', description: '  details  ', urgent: true,
    }, { 'idempotency-key': 'create-operation-1' });
    const replay = await request('POST', '/tasks', {
      title: '  Retry-safe task  ', description: '  details  ', urgent: true,
    }, { 'idempotency-key': 'create-operation-1' });
    const conflict = await request('POST', '/tasks', {
      title: 'different',
    }, { 'idempotency-key': 'create-operation-1' });

    expect(first.statusCode).toBe(201);
    expect(first.headers.etag).toBe('"0"');
    expect(first.json()).toMatchObject({
      title: 'Retry-safe task', description: 'details', urgent: true,
      important: false, lifecycleState: 'active', revision: 0,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()._id).toBe(first.json()._id);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('idempotency_key_reused');
  });

  it('collapses concurrent creates with one key', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(
      'POST', '/tasks', { title: 'Concurrent', important: true },
      { 'idempotency-key': 'concurrent-operation-1' },
    )));

    expect(responses.filter(({ statusCode }) => statusCode === 201)).toHaveLength(1);
    expect(responses.filter(({ statusCode }) => statusCode === 200)).toHaveLength(7);
    expect(new Set(responses.map((response) => response.json()._id)).size).toBe(1);
  });

  it('enforces strict If-Match grammar and owner/tenant isolation on update', async () => {
    const owned = await TaskModel.create({ tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Owned' });
    const foreign = await TaskModel.create({ tenantId: 'tenant-a', ownerId: 'owner-b', title: 'Foreign' });
    const missing = await request('PUT', `/tasks/${owned.id}`, { urgent: true });
    const weak = await request('PUT', `/tasks/${owned.id}`, { urgent: true }, { 'if-match': 'W/"0"' });
    const malformed = await request('PUT', `/tasks/${owned.id}`, { urgent: true }, { 'if-match': '0' });
    const unsafe = await request('PUT', `/tasks/${owned.id}`, { urgent: true }, {
      'if-match': '"9007199254740992"',
    });
    const updated = await request('PUT', `/tasks/${owned.id}`, { title: ' Updated ' }, {
      'if-match': '"0"',
    });
    const hidden = await request('PUT', `/tasks/${foreign.id}`, { title: 'stolen' }, {
      'if-match': '"0"',
    });

    expect(missing.statusCode).toBe(428);
    expect(missing.json().code).toBe('precondition_required');
    for (const response of [weak, malformed, unsafe]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'If-Match must contain a strong quoted numeric task revision',
      });
    }
    expect(updated.statusCode).toBe(200);
    expect(updated.headers.etag).toBe('"1"');
    expect(updated.json()).toMatchObject({ title: 'Updated', revision: 1 });
    expect(hidden.statusCode).toBe(404);
  });

  it('preserves validation shape, unknown-field rejection and string bounds', async () => {
    const unknown = await request('POST', '/tasks', { title: 'valid', role: 'admin' });
    const invalid = await request('POST', '/tasks', {
      title: '', description: 'x'.repeat(2001), urgent: 'yes', important: 1,
    });
    const badKey = await request('POST', '/tasks', { title: 'valid' }, {
      'idempotency-key': 'contains spaces',
    });

    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({
      error: 'Validation failed', details: ['Unexpected task field'],
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({
      error: 'Validation failed', details: ['Invalid value', 'Invalid value', 'Invalid value', 'Invalid value'],
    });
    expect(badKey.statusCode).toBe(400);
    expect(badKey.json()).toEqual({
      error: 'Idempotency-Key must contain 1-128 URL-safe characters',
    });
  });

  it('validates route ids before preconditions and preserves nested-shape errors', async () => {
    const invalidId = await request('PUT', '/tasks/not-an-id', { urgent: true });
    const task = await TaskModel.create({ tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Shapes' });
    const schedule = await request('PUT', `/tasks/${task.id}/schedule`, { schedule: 'tomorrow' }, {
      'if-match': '"0"',
    });
    const delegation = await request('PUT', `/tasks/${task.id}/delegation`, { delegation: [] }, {
      'if-match': '"0"',
    });

    expect(invalidId.statusCode).toBe(400);
    expect(invalidId.json()).toEqual({ error: 'Validation failed', details: ['Invalid value'] });
    expect(schedule.json()).toEqual({
      error: 'Validation failed', details: ['schedule must be an object or null'],
    });
    expect(delegation.json()).toEqual({
      error: 'Validation failed', details: ['delegation must be an object or null'],
    });
  });

  it('transitions lifecycle and rejects invalid/stale transitions', async () => {
    const task = await TaskModel.create({ tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Lifecycle' });
    const invalid = await request('PUT', `/tasks/${task.id}/lifecycle`, { action: 'restore' }, {
      'if-match': '"0"',
    });
    const completed = await request('PUT', `/tasks/${task.id}/lifecycle`, { action: 'complete' }, {
      'if-match': '"0"',
    });
    const stale = await request('PUT', `/tasks/${task.id}/lifecycle`, { action: 'trash' }, {
      'if-match': '"0"',
    });

    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().code).toBe('invalid_lifecycle_transition');
    expect(completed.json()).toMatchObject({ lifecycleState: 'completed', revision: 1 });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().code).toBe('task_revision_conflict');
  });

  it('sets/clears schedules and offers/transitions delegation', async () => {
    const task = await TaskModel.create({ tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Workflow' });
    const scheduled = await request('PUT', `/tasks/${task.id}/schedule`, {
      schedule: {
        dueAt: '2026-08-30T12:00:00.000Z', timeZone: 'Europe/Warsaw',
        remindAt: '2026-08-30T10:00:00.000Z',
      },
    }, { 'if-match': '"0"' });
    const offered = await request('PUT', `/tasks/${task.id}/delegation`, {
      delegation: { assigneeUserId: 'user-b', displayLabel: ' Pat ', handoffNote: ' note ' },
    }, { 'if-match': '"1"' });
    const accepted = await request(
      'PUT', `/tasks/${task.id}/delegation/status`, { status: 'accepted' },
      { 'if-match': '"2"' }, 'tenant-a:user-b',
    );
    const cleared = await request('PUT', `/tasks/${task.id}/schedule`, { schedule: null }, {
      'if-match': '"3"',
    });

    expect(scheduled.json()).toMatchObject({ revision: 1, schedule: { durationMinutes: 30 } });
    expect(offered.json()).toMatchObject({
      revision: 2,
      delegation: { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: 'note', status: 'offered' },
    });
    expect(accepted.json()).toMatchObject({ revision: 3, delegation: { status: 'accepted' } });
    expect(cleared.json()).toMatchObject({ revision: 4 });
    expect(cleared.json().schedule).toBeUndefined();
  });

  it('allows final deletion only from trash and keeps deleted replay semantics', async () => {
    const created = await request('POST', '/tasks', { title: 'Delete me' }, {
      'idempotency-key': 'deleted-operation-1',
    });
    const rejected = await request('DELETE', `/tasks/${created.json()._id}`, undefined, {
      'if-match': '"0"',
    });
    const trashed = await request('PUT', `/tasks/${created.json()._id}/lifecycle`, { action: 'trash' }, {
      'if-match': '"0"',
    });
    const deleted = await request('DELETE', `/tasks/${created.json()._id}`, undefined, {
      'if-match': '"1"',
    });
    const replay = await request('POST', '/tasks', { title: 'Delete me' }, {
      'idempotency-key': 'deleted-operation-1',
    });

    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe('task_not_trashed');
    expect(trashed.statusCode).toBe(200);
    expect(deleted.statusCode).toBe(204);
    expect(replay.statusCode).toBe(410);
    expect(replay.json().code).toBe('idempotency_result_deleted');
  });
});
