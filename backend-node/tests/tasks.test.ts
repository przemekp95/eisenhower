import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { TaskModel } from '../src/models/task';
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
    const updated = await api.put(`/tasks/${foreign.id}`).send({ urgent: false });
    const deleted = await api.delete(`/tasks/${foreign.id}`);

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
    const updated = await request(oidcApp).put(`/tasks/${foreign.id}`).send({ urgent: false });
    const deleted = await request(oidcApp).delete(`/tasks/${foreign.id}`);

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
      description: '',
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
    const response = await api.put(`/tasks/${id}`).send({ urgent: true });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Task not found');
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
    const response = await api.delete(`/tasks/${id}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Task not found');
  });

  it('rejects malformed If-Match on delete', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const response = await api.delete(`/tasks/${id}`).set('If-Match', '*');

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('quoted numeric task revision');
  });

  it('rejects a stale conditional delete and accepts the current revision', async () => {
    const task = await TaskModel.create({ title: 'Conditional delete', urgent: false, important: false });
    await api.put(`/tasks/${task.id}`).set('If-Match', 'W/"0"').send({ urgent: true });

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

    const response = await api.delete(`/tasks/${task.id}`);

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
        lean: async () => {
          throw 'list failure';
        },
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

    const response = await api.put(`/tasks/${id}`).send({ urgent: true });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('update failure');
  });

  it('returns 500 when deleting a task fails', async () => {
    jest.spyOn(TaskModel, 'findOneAndDelete').mockRejectedValue(new Error('delete failure'));
    const id = new mongoose.Types.ObjectId().toString();

    const response = await api.delete(`/tasks/${id}`);

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('delete failure');
  });
});
