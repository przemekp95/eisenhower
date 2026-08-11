import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { TaskModel } from '../src/models/task';
import { MongooseTaskRepository } from '../src/repositories/mongooseTaskRepository';
import { createTasksRouter } from '../src/routes/tasks';
import { clearMongo, startMongo, stopMongo } from './helpers/mongo';

describe('task routes', () => {
  const app = createApp({
    aiHealthChecker: async () => 'healthy',
    databaseStatusResolver: () => 'connected',
  });
  const api = {
    get: (path: string) => request(app).get(path).set('Authorization', 'Bearer test-api-token'),
    post: (path: string) => request(app).post(path).set('Authorization', 'Bearer test-api-token'),
    put: (path: string) => request(app).put(path).set('Authorization', 'Bearer test-api-token'),
    delete: (path: string) => request(app).delete(path).set('Authorization', 'Bearer test-api-token'),
  };

  beforeAll(async () => {
    await startMongo();
  });

  afterEach(async () => {
    await clearMongo();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await stopMongo();
  });

  it('returns tasks sorted from newest to oldest', async () => {
    await TaskModel.create([
      { title: 'first', urgent: true, important: false },
      { title: 'second', urgent: false, important: true },
    ]);

    const response = await api.get('/tasks');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body[0].title).toBe('second');
    expect(response.body[1].title).toBe('first');
  });

  it('does not list, update, or delete another tenant task', async () => {
    const foreign = await TaskModel.create({
      tenantId: 'tenant-b',
      ownerId: 'foreign-user',
      title: 'Foreign task',
      urgent: true,
      important: true,
    });

    const listed = await api.get('/tasks');
    const updated = await api.put(`/tasks/${foreign.id}`).set('If-Match', '"0"').send({ urgent: false });
    const deleted = await api.delete(`/tasks/${foreign.id}`).set('If-Match', '"0"');

    expect(listed.body).toEqual([]);
    expect(updated.status).toBe(404);
    expect(deleted.status).toBe(404);
    await expect(TaskModel.findById(foreign.id)).resolves.not.toBeNull();
  });

  it('does not list, update, or delete another owner task in the same OIDC tenant', async () => {
    const foreign = await TaskModel.create({
      tenantId: 'tenant-a',
      ownerId: 'user-b',
      title: 'Private user B task',
      urgent: true,
      important: true,
    });
    const oidcApp = express();
    oidcApp.use(express.json());
    oidcApp.use((req, _res, next) => {
      req.auth = { tenantId: 'tenant-a', userId: 'user-a', roles: ['user'], projectIds: [] };
      next();
    });
    oidcApp.use('/tasks', createTasksRouter());

    const listed = await request(oidcApp).get('/tasks');
    const updated = await request(oidcApp).put(`/tasks/${foreign.id}`).set('If-Match', '"0"').send({ urgent: false });
    const deleted = await request(oidcApp).delete(`/tasks/${foreign.id}`).set('If-Match', '"0"');

    expect(listed.body).toEqual([]);
    expect(updated.status).toBe(404);
    expect(deleted.status).toBe(404);
    await expect(TaskModel.findById(foreign.id)).resolves.toMatchObject({ ownerId: 'user-b' });
  });

  it('creates a task with defaults', async () => {
    const response = await api.post('/tasks').send({ title: 'Ship release' });

    expect(response.status).toBe(201);
    expect(response.headers.etag).toBe('"0"');
    expect(response.body).toMatchObject({
      title: 'Ship release',
      description: '',
      urgent: false,
      important: false,
      revision: 0,
    });
  });

  it('serializes stored project ids while hiding internal idempotency metadata', async () => {
    const task = await TaskModel.create({
      title: 'Scoped project task',
      projectId: 'project-a',
      createOperationId: 'internal-operation',
      createOperationDigest: 'internal-digest',
    });

    const serialized = task.toJSON();
    expect(serialized._id).toBe(task.id);
    expect(serialized).not.toHaveProperty('createOperationId');
    expect(serialized).not.toHaveProperty('createOperationDigest');

    const listed = await api.get('/tasks');
    expect(listed.body[0]).toMatchObject({
      _id: task.id,
      projectId: 'project-a',
    });
  });

  it('replays an idempotent create without creating a second task', async () => {
    const first = await api
      .post('/tasks')
      .set('Idempotency-Key', 'mobile-create-operation-1')
      .send({ title: 'Retry-safe task', urgent: true });
    const replay = await api
      .post('/tasks')
      .set('Idempotency-Key', 'mobile-create-operation-1')
      .send({ title: 'Retry-safe task', urgent: true });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body._id).toBe(first.body._id);
    await expect(TaskModel.countDocuments({ title: 'Retry-safe task' })).resolves.toBe(1);
  });

  it('does not recreate an idempotent task after it was deleted', async () => {
    const operationId = 'mobile-deleted-operation-1';
    const first = await api
      .post('/tasks')
      .set('Idempotency-Key', operationId)
      .send({ title: 'Delete after create', description: 'private body', urgent: true });
    const deleted = await api
      .delete(`/tasks/${first.body._id}`)
      .set('If-Match', `"${first.body.revision}"`);

    const replay = await api
      .post('/tasks')
      .set('Idempotency-Key', operationId)
      .send({ title: 'Delete after create', description: 'private body', urgent: true });
    const changedReplay = await api
      .post('/tasks')
      .set('Idempotency-Key', operationId)
      .send({ title: 'Changed after delete' });
    const listed = await api.get('/tasks');

    expect(first.status).toBe(201);
    expect(deleted.status).toBe(204);
    expect(replay.status).toBe(410);
    expect(replay.body.code).toBe('idempotency_result_deleted');
    expect(changedReplay.status).toBe(409);
    expect(changedReplay.body.code).toBe('idempotency_key_reused');
    expect(listed.body).toEqual([]);
    await expect(TaskModel.countDocuments({ createOperationId: operationId })).resolves.toBe(1);
    await expect(TaskModel.findOne({ createOperationId: operationId }).select('+createOperationDigest +deletedAt'))
      .resolves.toMatchObject({
        title: '[deleted]',
        description: '',
        urgent: false,
        important: false,
        deletedAt: expect.any(Date),
      });
  });

  it('collapses concurrent creates with one operation key to one owner-scoped task', async () => {
    const responses = await Promise.all(
      Array.from({ length: 16 }, () => api
        .post('/tasks')
        .set('Idempotency-Key', 'mobile-concurrent-operation-1')
        .send({ title: 'Concurrent task', description: 'same payload', important: true })),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(15);
    expect(new Set(responses.map((response) => response.body._id)).size).toBe(1);
    await expect(TaskModel.countDocuments({ title: 'Concurrent task' })).resolves.toBe(1);
  });

  it('rejects reusing an operation key for a different payload', async () => {
    await api
      .post('/tasks')
      .set('Idempotency-Key', 'mobile-payload-operation-1')
      .send({ title: 'Original payload' });
    const response = await api
      .post('/tasks')
      .set('Idempotency-Key', 'mobile-payload-operation-1')
      .send({ title: 'Changed payload' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Idempotency key was already used with a different task payload',
      code: 'idempotency_key_reused',
    });
  });

  it('fails closed when an idempotent upsert cannot be read back', async () => {
    jest.spyOn(TaskModel, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => null }),
    } as never);
    const repository = new MongooseTaskRepository();

    await expect(repository.create(
      { tenantId: 'local', ownerId: 'local-user' },
      { title: 'Unreadable create', description: '', urgent: false, important: false },
      { id: 'unreadable-operation', payloadDigest: 'digest' },
    )).rejects.toThrow('Idempotent task create did not return a task');
  });

  it('scopes an idempotency key by both tenant and owner', async () => {
    const scopedApp = express();
    scopedApp.use(express.json());
    scopedApp.use((req, _res, next) => {
      req.auth = {
        tenantId: String(req.get('x-test-tenant')),
        userId: String(req.get('x-test-owner')),
        roles: ['user'],
        projectIds: [],
      };
      next();
    });
    scopedApp.use('/tasks', createTasksRouter());

    const createFor = (tenantId: string, ownerId: string) => request(scopedApp)
      .post('/tasks')
      .set('X-Test-Tenant', tenantId)
      .set('X-Test-Owner', ownerId)
      .set('Idempotency-Key', 'shared-operation-key')
      .send({ title: `${tenantId}/${ownerId}` });
    const [tenantAOwnerA, tenantAOwnerB, tenantBOwnerA] = await Promise.all([
      createFor('tenant-a', 'owner-a'),
      createFor('tenant-a', 'owner-b'),
      createFor('tenant-b', 'owner-a'),
    ]);

    expect([tenantAOwnerA.status, tenantAOwnerB.status, tenantBOwnerA.status]).toEqual([201, 201, 201]);
    expect(new Set([tenantAOwnerA.body._id, tenantAOwnerB.body._id, tenantBOwnerA.body._id]).size).toBe(3);
    await expect(TaskModel.countDocuments({ createOperationId: 'shared-operation-key' })).resolves.toBe(3);
  });

  it('rejects malformed idempotency keys', async () => {
    const response = await api
      .post('/tasks')
      .set('Idempotency-Key', 'contains spaces')
      .send({ title: 'Unsafe key' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Idempotency-Key must contain 1-128 URL-safe characters');
  });

  it('rejects invalid payloads', async () => {
    const response = await api.post('/tasks').send({ title: '' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });

  it('rejects unexpected task fields instead of mass assigning them', async () => {
    const response = await api.post('/tasks').send({
      title: 'Do not elevate',
      role: 'admin',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });

  it('rejects a non-object request body', async () => {
    const response = await api.post('/tasks').send(['not', 'an', 'object']);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
    expect(response.body.details).toContain('Request body must be an object');
  });

  it('updates a task', async () => {
    const task = await TaskModel.create({
      title: 'Review PR',
      description: 'needs attention',
      urgent: false,
      important: true,
    });

    const response = await api
      .put(`/tasks/${task.id}`)
      .set('If-Match', '"0"')
      .send({ urgent: true, important: true });

    expect(response.status).toBe(200);
    expect(response.body.urgent).toBe(true);
    expect(response.body.important).toBe(true);
  });

  it('rejects a stale conditional update without overwriting the current task', async () => {
    const task = await TaskModel.create({ title: 'Original', urgent: false, important: true });
    const first = await api
      .put(`/tasks/${task.id}`)
      .set('If-Match', '"0"')
      .send({ title: 'First writer' });
    const stale = await api
      .put(`/tasks/${task.id}`)
      .set('If-Match', '"0"')
      .send({ title: 'Stale writer' });

    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe('"1"');
    expect(stale.status).toBe(412);
    expect(stale.body).toEqual({ error: 'Task revision conflict', code: 'task_revision_conflict' });
    await expect(TaskModel.findById(task.id)).resolves.toMatchObject({ title: 'First writer' });
  });

  it('treats a pre-revision task as revision zero during a compatible migration', async () => {
    const inserted = await TaskModel.collection.insertOne({
      tenantId: 'local',
      ownerId: 'local-user',
      title: 'Legacy task',
      urgent: false,
      important: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const listed = await api.get('/tasks');
    expect(listed.body[0]).toMatchObject({ _id: inserted.insertedId.toString(), revision: 0 });

    const updated = await api
      .put(`/tasks/${inserted.insertedId}`)
      .set('If-Match', '"0"')
      .send({ title: 'Migrated task' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ title: 'Migrated task', revision: 1 });
    expect(updated.headers.etag).toBe('"1"');
  });

  it('keeps the legacy array response while paginating with an opaque cursor', async () => {
    await TaskModel.create([
      { title: 'one', urgent: false, important: false },
      { title: 'two', urgent: false, important: false },
      { title: 'three', urgent: false, important: false },
    ]);

    const first = await api.get('/tasks?limit=2');
    expect(first.status).toBe(200);
    expect(Array.isArray(first.body)).toBe(true);
    expect(first.body).toHaveLength(2);
    expect(first.headers['x-next-cursor']).toEqual(expect.any(String));

    const second = await api.get(`/tasks?limit=2&cursor=${encodeURIComponent(first.headers['x-next-cursor'])}`);
    expect(second.status).toBe(200);
    expect(second.body).toHaveLength(1);
    expect(new Set([...first.body, ...second.body].map((task) => task._id)).size).toBe(3);
  });

  it('bounds the default list and emits a proxy-prefix-safe next-page contract', async () => {
    await TaskModel.insertMany(
      Array.from({ length: 101 }, (_, index) => ({
        title: `default-page-${index}`,
        urgent: false,
        important: false,
      })),
    );

    const first = await api.get('/tasks');

    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(100);
    expect(first.headers['x-next-cursor']).toEqual(expect.any(String));
    expect(first.headers.link).toMatch(/^<\?limit=100&cursor=[^>]+>; rel="next"$/);

    const second = await api.get(`/tasks?limit=100&cursor=${encodeURIComponent(first.headers['x-next-cursor'])}`);
    expect(second.body).toHaveLength(1);
    expect(new Set([...first.body, ...second.body].map((task) => task._id)).size).toBe(101);
  });

  it.each(['0', '201', '1.5', 'not-a-number'])(
    'rejects invalid pagination limit %s',
    async (limit) => {
      const response = await api.get(`/tasks?limit=${limit}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('limit must be an integer from 1 to 200');
    }
  );

  it.each([
    '',
    'not-json',
    Buffer.from(JSON.stringify({ id: new mongoose.Types.ObjectId().toString() })).toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: 'not-a-date', id: new mongoose.Types.ObjectId().toString() })).toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: new Date().toISOString() })).toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), id: 'not-an-id' })).toString('base64url'),
  ])('rejects invalid pagination cursor %#', async (cursor) => {
    const response = await api.get(`/tasks?cursor=${encodeURIComponent(cursor)}`);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid task cursor');
  });

  it('uses the default page size when continuing from a cursor without a limit', async () => {
    const cursor = Buffer.from(JSON.stringify({
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      id: new mongoose.Types.ObjectId().toString(),
    })).toString('base64url');
    await TaskModel.create({ title: 'one', urgent: false, important: false });

    const response = await api.get(`/tasks?cursor=${encodeURIComponent(cursor)}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
  });

  it('defines the owner-scoped pagination index', () => {
    expect(TaskModel.schema.indexes()).toContainEqual([
      { tenantId: 1, ownerId: 1, createdAt: -1, _id: -1 },
      expect.any(Object),
    ]);
  });

  it('returns 404 for a missing task on update', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const response = await api.put(`/tasks/${id}`).set('If-Match', '"0"').send({ urgent: true });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Task not found');
  });

  it('requires If-Match for update and rejects a weak task revision', async () => {
    const task = await TaskModel.create({ title: 'Guarded update' });
    const missing = await api.put(`/tasks/${task.id}`).send({ urgent: true });
    const weak = await api.put(`/tasks/${task.id}`).set('If-Match', 'W/"0"').send({ urgent: true });

    expect(missing.status).toBe(428);
    expect(missing.body.code).toBe('precondition_required');
    expect(weak.status).toBe(400);
    expect(weak.body.error).toContain('strong quoted numeric task revision');
  });

  it('rejects an If-Match revision outside the safe integer range', async () => {
    const task = await TaskModel.create({ title: 'Unsafe revision' });
    const response = await api
      .put(`/tasks/${task.id}`)
      .set('If-Match', '"9007199254740992"')
      .send({ urgent: true });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('strong quoted numeric task revision');
  });

  it('rejects malformed If-Match on update', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const response = await api.put(`/tasks/${id}`).set('If-Match', '0').send({ urgent: true });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('quoted numeric task revision');
  });

  it('rejects invalid payloads on update', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const response = await api.put(`/tasks/${id}`).send({ title: '' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
    expect(response.body.details).toContain('Invalid value');
  });

  it('rejects malformed ids', async () => {
    const response = await api.delete('/tasks/not-an-id');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });

  it('returns 404 for a missing task on delete', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const response = await api.delete(`/tasks/${id}`).set('If-Match', '"0"');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Task not found');
  });

  it('requires If-Match for delete', async () => {
    const task = await TaskModel.create({ title: 'Guarded delete' });
    const response = await api.delete(`/tasks/${task.id}`);

    expect(response.status).toBe(428);
    expect(response.body.code).toBe('precondition_required');
  });

  it('rejects malformed If-Match on delete', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const response = await api.delete(`/tasks/${id}`).set('If-Match', '*');

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('quoted numeric task revision');
  });

  it('rejects a stale conditional delete and accepts the current revision', async () => {
    const task = await TaskModel.create({ title: 'Conditional delete', urgent: false, important: false });
    await api.put(`/tasks/${task.id}`).set('If-Match', '"0"').send({ urgent: true });

    const stale = await api.delete(`/tasks/${task.id}`).set('If-Match', '"0"');
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('task_revision_conflict');

    const current = await api.delete(`/tasks/${task.id}`).set('If-Match', '"1"');
    expect(current.status).toBe(204);
  });

  it('deletes a task', async () => {
    const task = await TaskModel.create({
      title: 'Delete me',
      urgent: false,
      important: false,
    });

    const response = await api.delete(`/tasks/${task.id}`).set('If-Match', '"0"');

    expect(response.status).toBe(204);
    await expect(TaskModel.findById(task.id)).resolves.toBeNull();
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const response = await api.get('/missing');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Route not found');
  });

  it('returns 500 when listing tasks fails', async () => {
    jest.spyOn(TaskModel, 'find').mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => {
            throw 'list failure';
          },
        }),
      }),
    } as never);

    const response = await api.get('/tasks');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Internal server error');
  });

  it('returns 500 when creating a task fails', async () => {
    jest.spyOn(TaskModel, 'create').mockRejectedValue(new Error('create failure'));

    const response = await api.post('/tasks').send({ title: 'Broken create' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('create failure');
  });

  it('returns 500 when updating a task fails', async () => {
    jest.spyOn(TaskModel, 'findOneAndUpdate').mockRejectedValue(new Error('update failure'));
    const id = new mongoose.Types.ObjectId().toString();

    const response = await api.put(`/tasks/${id}`).set('If-Match', '"0"').send({ urgent: true });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('update failure');
  });

  it('returns 500 when deleting a task fails', async () => {
    jest.spyOn(TaskModel, 'findOneAndDelete').mockRejectedValue(new Error('delete failure'));
    const id = new mongoose.Types.ObjectId().toString();

    const response = await api.delete(`/tasks/${id}`).set('If-Match', '"0"');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('delete failure');
  });
});
