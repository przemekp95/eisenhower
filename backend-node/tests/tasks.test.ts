import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app';
import { TaskModel } from '../src/models/task';
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

  it('creates a task with defaults', async () => {
    const response = await api.post('/tasks').send({ title: 'Ship release' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      title: 'Ship release',
      description: '',
      urgent: false,
      important: false,
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

  it('returns 404 for a missing task on update', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const response = await api.put(`/tasks/${id}`).send({ urgent: true });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Task not found');
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
