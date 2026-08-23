import mongoose from 'mongoose';
import { createNestApp } from '../../src/nest-app';
import { TaskModel } from '../../src/models/task';
import { clearMongo, startMongo, stopMongo } from '../helpers/mongo';

describe('Nest Fastify task queries', () => {
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

  function get(path: string, principal = 'tenant-a:owner-a') {
    return app.inject({
      method: 'GET', url: path, headers: { authorization: `Bearer ${principal}` },
    });
  }

  it('lists only owned tasks and preserves lifecycle filters', async () => {
    await TaskModel.create([
      { tenantId: 'tenant-a', ownerId: 'owner-a', title: 'active task' },
      { tenantId: 'tenant-a', ownerId: 'owner-a', title: 'completed task', lifecycleState: 'completed' },
      { tenantId: 'tenant-a', ownerId: 'owner-b', title: 'other owner' },
      { tenantId: 'tenant-b', ownerId: 'owner-a', title: 'other tenant' },
    ]);

    const active = await get('/tasks');
    const completed = await get('/tasks?lifecycle=completed');
    const all = await get('/tasks?lifecycle=all');
    const invalid = await get('/tasks?lifecycle=unknown');

    expect(active.statusCode).toBe(200);
    expect(active.json().map((task: { title: string }) => task.title)).toEqual(['active task']);
    expect(completed.json().map((task: { title: string }) => task.title)).toEqual(['completed task']);
    expect(new Set(all.json().map((task: { title: string }) => task.title))).toEqual(
      new Set(['active task', 'completed task']),
    );
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'Invalid lifecycle filter' });
  });

  it('hides foreign tasks, validates ids and emits the exact ETag', async () => {
    const owned = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'owned',
    });
    await TaskModel.collection.updateOne({ _id: owned._id }, { $set: { revision: 7 } });
    const foreign = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-b', title: 'foreign',
    });

    const found = await get(`/tasks/${owned.id}`);
    const hidden = await get(`/tasks/${foreign.id}`);
    const invalid = await get('/tasks/not-an-id');
    const missing = await get(`/tasks/${new mongoose.Types.ObjectId()}`);

    expect(found.statusCode).toBe(200);
    expect(found.headers.etag).toBe('"7"');
    expect(found.json()).toMatchObject({ _id: owned.id, title: 'owned', revision: 7 });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: 'Task not found' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'Validation failed', details: ['Invalid value'] });
    expect(missing.statusCode).toBe(404);
  });

  it('paginates with opaque cursors and exact continuation headers', async () => {
    await TaskModel.create([
      { tenantId: 'tenant-a', ownerId: 'owner-a', title: 'one' },
      { tenantId: 'tenant-a', ownerId: 'owner-a', title: 'two' },
      { tenantId: 'tenant-a', ownerId: 'owner-a', title: 'three' },
    ]);

    const first = await get('/tasks?limit=2');
    const cursor = String(first.headers['x-next-cursor']);
    const second = await get(`/tasks?limit=2&cursor=${encodeURIComponent(cursor)}`);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toHaveLength(2);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.headers.link).toMatch(/^<\?limit=2&cursor=[^>]+>; rel="next"$/);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toHaveLength(1);
    expect(new Set([...first.json(), ...second.json()].map((task) => task._id)).size).toBe(3);
  });

  it.each(['/tasks?limit=0', '/tasks?limit=201', '/tasks?limit=1.5', '/tasks?limit=nope'])(
    'rejects an invalid limit at %s',
    async (path) => {
      const response = await get(path);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'limit must be an integer from 1 to 200' });
    },
  );

  it.each([
    '/tasks?cursor=',
    '/tasks?cursor=not-json',
    '/tasks?cursor=a&cursor=b',
    `/tasks?cursor=${Buffer.from(JSON.stringify({ createdAt: 'not-a-date', id: new mongoose.Types.ObjectId().toString() })).toString('base64url')}`,
  ])('rejects an invalid or repeated cursor at %s', async (path) => {
    const response = await get(path);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Invalid task cursor' });
  });

  it('keeps default 100 and maximum 200 page bounds', async () => {
    await TaskModel.insertMany(Array.from({ length: 201 }, (_, index) => ({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: `task-${index}`,
    })));

    const defaultPage = await get('/tasks');
    const maximumPage = await get('/tasks?limit=200');

    expect(defaultPage.json()).toHaveLength(100);
    expect(defaultPage.headers['x-next-cursor']).toBeDefined();
    expect(maximumPage.json()).toHaveLength(200);
    expect(maximumPage.headers['x-next-cursor']).toBeDefined();
  });

  it('lists delegated work only for the same-tenant assignee and lifecycle', async () => {
    await TaskModel.create([
      {
        tenantId: 'tenant-a', ownerId: 'owner-a', title: 'delegated active',
        delegation: {
          assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '', status: 'offered',
          offeredAt: new Date('2026-08-23T10:00:00.000Z'),
          statusUpdatedAt: new Date('2026-08-23T10:00:00.000Z'),
        },
      },
      {
        tenantId: 'tenant-a', ownerId: 'owner-a', title: 'delegated completed',
        lifecycleState: 'completed',
        delegation: {
          assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '', status: 'completed',
          offeredAt: new Date('2026-08-23T09:00:00.000Z'),
          statusUpdatedAt: new Date('2026-08-23T09:00:00.000Z'),
        },
      },
      {
        tenantId: 'tenant-b', ownerId: 'owner-z', title: 'other tenant delegation',
        delegation: {
          assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '', status: 'offered',
          offeredAt: new Date('2026-08-23T08:00:00.000Z'),
          statusUpdatedAt: new Date('2026-08-23T08:00:00.000Z'),
        },
      },
    ]);

    const active = await get('/tasks/delegated', 'tenant-a:user-b');
    const all = await get('/tasks/delegated?lifecycle=all', 'tenant-a:user-b');
    const otherTenant = await get('/tasks/delegated?lifecycle=all', 'tenant-b:user-b');

    expect(active.json().map((task: { title: string }) => task.title)).toEqual(['delegated active']);
    expect(new Set(all.json().map((task: { title: string }) => task.title))).toEqual(
      new Set(['delegated active', 'delegated completed']),
    );
    expect(otherTenant.json().map((task: { title: string }) => task.title)).toEqual([
      'other tenant delegation',
    ]);
  });
});
