import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { resolveLifecycleTransition } from '../src/application/taskRepository';
import { TaskModel } from '../src/models/task';
import { MongooseTaskRepository } from '../src/repositories/mongooseTaskRepository';
import { createTasksRouter } from '../src/routes/tasks';
import {
  CalendarBindingModel,
  CalendarConnectionModel,
  CalendarOutboxModel,
} from '../src/models/calendar';
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
    delete: (path: string) =>
      request(app).delete(path).set('Authorization', 'Bearer test-api-token'),
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

  it('returns not found for a valid unknown id and maps get failures', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    expect((await api.get(`/tasks/${id}`)).status).toBe(404);
    jest.spyOn(MongooseTaskRepository.prototype, 'get').mockRejectedValueOnce(new Error('get failure'));
    const failed = await api.get(`/tasks/${id}`);
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('get failure');
  });

  it('rejects an invalid task id on the get endpoint', async () => {
    const response = await api.get('/tasks/not-an-id');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
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
    const updated = await api
      .put(`/tasks/${foreign.id}`)
      .set('If-Match', '"0"')
      .send({ urgent: false });
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
    const updated = await request(oidcApp)
      .put(`/tasks/${foreign.id}`)
      .set('If-Match', '"0"')
      .send({ urgent: false });
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
      lifecycleState: 'active',
      revision: 0,
    });
  });

  it('sets and clears a revision-safe schedule without changing lifecycle state', async () => {
    const task = await TaskModel.create({ title: 'Prepare release', lifecycleState: 'completed' });

    const scheduled = await api
      .put(`/tasks/${task.id}/schedule`)
      .set('If-Match', '"0"')
      .send({
        schedule: {
          dueAt: '2026-08-15T12:00:00.000Z',
          timeZone: 'Europe/Warsaw',
          remindAt: '2026-08-15T10:00:00.000Z',
        },
      });
    const cleared = await api
      .put(`/tasks/${task.id}/schedule`)
      .set('If-Match', '"1"')
      .send({ schedule: null });

    expect(scheduled.status).toBe(200);
    expect(scheduled.headers.etag).toBe('"1"');
    expect(scheduled.body).toMatchObject({
      lifecycleState: 'completed',
      revision: 1,
      schedule: {
        dueAt: '2026-08-15T12:00:00.000Z',
        timeZone: 'Europe/Warsaw',
        remindAt: '2026-08-15T10:00:00.000Z',
      },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ lifecycleState: 'completed', revision: 2 });
    expect(cleared.body.schedule).toBeUndefined();
  });

  it('validates schedule shape, UTC instants, timezone, reminder order, ownership, and revisions', async () => {
    const task = await TaskModel.create({ title: 'Guarded schedule' });
    const foreign = await TaskModel.create({
      tenantId: 'other-tenant',
      ownerId: 'other-owner',
      title: 'Foreign schedule',
    });
    const validSchedule = {
      dueAt: '2026-08-15T12:00:00.000Z',
      timeZone: 'Europe/Warsaw',
      remindAt: '2026-08-15T10:00:00.000Z',
    };

    const missingRevision = await api.put(`/tasks/${task.id}/schedule`).send({
      schedule: validSchedule,
    });
    const missingTimezone = await api
      .put(`/tasks/${task.id}/schedule`)
      .set('If-Match', '"0"')
      .send({ schedule: { dueAt: validSchedule.dueAt } });
    const offsetInstant = await api
      .put(`/tasks/${task.id}/schedule`)
      .set('If-Match', '"0"')
      .send({ schedule: { ...validSchedule, dueAt: '2026-08-15T14:00:00+02:00' } });
    const invalidTimezone = await api
      .put(`/tasks/${task.id}/schedule`)
      .set('If-Match', '"0"')
      .send({ schedule: { ...validSchedule, timeZone: 'Mars/Olympus' } });
    const lateReminder = await api
      .put(`/tasks/${task.id}/schedule`)
      .set('If-Match', '"0"')
      .send({ schedule: { ...validSchedule, remindAt: '2026-08-15T12:00:01.000Z' } });
    const recurrence = await api
      .put(`/tasks/${task.id}/schedule`)
      .set('If-Match', '"0"')
      .send({ schedule: { ...validSchedule, recurrence: 'daily' } });
    const invalidDurations = await Promise.all([4, 1441, 5.5].map((durationMinutes) => api
      .put(`/tasks/${task.id}/schedule`)
      .set('If-Match', '"0"')
      .send({ schedule: { ...validSchedule, durationMinutes } })));
    const stale = await api
      .put(`/tasks/${task.id}/schedule`)
      .set('If-Match', '"7"')
      .send({ schedule: validSchedule });
    const foreignResult = await api
      .put(`/tasks/${foreign.id}/schedule`)
      .set('If-Match', '"0"')
      .send({ schedule: validSchedule });

    expect(missingRevision.status).toBe(428);
    expect(missingTimezone.status).toBe(400);
    expect(offsetInstant.status).toBe(400);
    expect(invalidTimezone.status).toBe(400);
    expect(lateReminder.status).toBe(400);
    expect(recurrence.status).toBe(400);
    expect(invalidDurations.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('task_revision_conflict');
    expect(foreignResult.status).toBe(404);
  });

  it('treats legacy tasks without lifecycle metadata as active', async () => {
    const inserted = await TaskModel.collection.insertOne({
      tenantId: 'local',
      ownerId: 'local-user',
      title: 'Legacy lifecycle task',
      urgent: false,
      important: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await api.get('/tasks?lifecycle=active');

    expect(response.status).toBe(200);
    expect(response.body).toContainEqual(
      expect.objectContaining({
        _id: inserted.insertedId.toString(),
        lifecycleState: 'active',
      })
    );
    await expect(
      new MongooseTaskRepository().getLifecycleState(
        { tenantId: 'local', ownerId: 'local-user' },
        inserted.insertedId.toString()
      )
    ).resolves.toBe('active');

    const transitioned = await api
      .put(`/tasks/${inserted.insertedId}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'complete' });
    expect(transitioned.body.lifecycleState).toBe('completed');
  });

  it('keeps lifecycle transition fallbacks deterministic for legacy trash metadata', () => {
    expect(resolveLifecycleTransition('completed', undefined, 'archive')).toEqual({
      state: 'archived',
    });
    expect(resolveLifecycleTransition('trashed', undefined, 'restore')).toEqual({
      state: 'active',
    });
  });

  it('moves through lifecycle states and restores the state remembered by trash', async () => {
    const task = await TaskModel.create({ title: 'Lifecycle task' });

    const completed = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'complete' });
    const trashed = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"1"')
      .send({ action: 'trash' });
    const activeList = await api.get('/tasks');
    const trashList = await api.get('/tasks?lifecycle=trashed');
    const allList = await api.get('/tasks?lifecycle=all');
    const restored = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"2"')
      .send({ action: 'restore' });

    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ lifecycleState: 'completed', revision: 1 });
    expect(trashed.status).toBe(200);
    expect(trashed.body).toMatchObject({ lifecycleState: 'trashed', revision: 2 });
    expect(activeList.body).toEqual([]);
    expect(trashList.body).toContainEqual(expect.objectContaining({ _id: task.id }));
    expect(allList.body).toContainEqual(expect.objectContaining({ _id: task.id }));
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ lifecycleState: 'completed', revision: 3 });
  });

  it('reopens completed tasks and restores archived tasks to active', async () => {
    const task = await TaskModel.create({ title: 'Reversible lifecycle' });

    const completed = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'complete' });
    const reopened = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"1"')
      .send({ action: 'reopen' });
    const archived = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"2"')
      .send({ action: 'archive' });
    const restored = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"3"')
      .send({ action: 'restore' });

    expect(completed.body.lifecycleState).toBe('completed');
    expect(reopened.body.lifecycleState).toBe('active');
    expect(archived.body.lifecycleState).toBe('archived');
    expect(restored.body).toMatchObject({ lifecycleState: 'active', revision: 4 });
  });

  it('keeps lifecycle filters across opaque pagination links', async () => {
    await TaskModel.create([
      { title: 'completed-one', lifecycleState: 'completed' },
      { title: 'completed-two', lifecycleState: 'completed' },
      { title: 'completed-three', lifecycleState: 'completed' },
      { title: 'active-one' },
    ]);

    const first = await api.get('/tasks?lifecycle=completed&limit=2');
    const cursor = first.headers['x-next-cursor'];
    const second = await api.get(
      `/tasks?lifecycle=completed&limit=2&cursor=${encodeURIComponent(cursor)}`
    );

    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(2);
    expect(first.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ lifecycleState: 'completed' })])
    );
    expect(first.headers.link).toContain('lifecycle=completed');
    expect(second.body).toHaveLength(1);
    expect(
      [...first.body, ...second.body].every((item) => item.lifecycleState === 'completed')
    ).toBe(true);
  });

  it('validates lifecycle filters, actions, transitions, ownership, and revisions', async () => {
    const task = await TaskModel.create({ title: 'Guarded lifecycle' });
    const foreign = await TaskModel.create({
      tenantId: 'tenant-b',
      ownerId: 'foreign-user',
      title: 'Foreign lifecycle',
    });

    const invalidFilter = await api.get('/tasks?lifecycle=unknown');
    const missingRevision = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .send({ action: 'complete' });
    const invalidAction = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'destroy' });
    const invalidBody = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send([]);
    const unexpectedField = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'complete', role: 'admin' });
    const invalidTransition = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'restore' });
    const completed = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'complete' });
    const stale = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'trash' });
    const foreignChange = await api
      .put(`/tasks/${foreign.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'complete' });

    expect(invalidFilter.status).toBe(400);
    expect(invalidFilter.body.error).toBe('Invalid lifecycle filter');
    expect(missingRevision.status).toBe(428);
    expect(invalidAction.status).toBe(400);
    expect(invalidBody.status).toBe(400);
    expect(unexpectedField.status).toBe(400);
    expect(invalidTransition.status).toBe(409);
    expect(invalidTransition.body.code).toBe('invalid_lifecycle_transition');
    expect(completed.status).toBe(200);
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('task_revision_conflict');
    expect(foreignChange.status).toBe(404);
  });

  it('uses the active lifecycle by default at the repository boundary', async () => {
    await TaskModel.create([
      { title: 'Repository active' },
      { title: 'Repository completed', lifecycleState: 'completed' },
    ]);
    const repository = new MongooseTaskRepository();

    const page = await repository.listPage({ tenantId: 'local', ownerId: 'local-user' }, 10);

    expect(page.tasks.map((task) => task.title)).toEqual(['Repository active']);
  });

  it('reports a revision conflict when lifecycle state changes during compare-and-set', async () => {
    const task = await TaskModel.create({ title: 'Lifecycle race' });
    jest.spyOn(TaskModel, 'findOneAndUpdate').mockResolvedValueOnce(null);
    const repository = new MongooseTaskRepository();

    await expect(
      repository.transitionLifecycle(
        { tenantId: 'local', ownerId: 'local-user' },
        task.id,
        0,
        'complete'
      )
    ).resolves.toEqual({ status: 'revision_conflict' });
  });

  it('enqueues calendar updates and deletes for bound task mutations', async () => {
    const task = await TaskModel.create({ title: 'Bound task' });
    await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: new mongoose.Types.ObjectId(),
      taskId: task.id, providerEventId: 'event-1', providerEtag: 'etag-1',
      lastTaskRevision: 0, lastProviderRevision: 'etag-1',
    });
    const repository = new MongooseTaskRepository();
    const scope = { tenantId: 'local', ownerId: 'local-user' };

    await repository.update(scope, task.id, 0, { title: 'Updated bound task' });
    await repository.updateSchedule(scope, task.id, 1, {
      dueAt: new Date('2026-08-20T12:00:00.000Z'), timeZone: 'Europe/Warsaw',
    });
    await repository.transitionLifecycle(scope, task.id, 2, 'archive');
    await repository.transitionLifecycle(scope, task.id, 3, 'restore');

    const types = (await CalendarOutboxModel.find().sort({ createdAt: 1 }).lean()).map((event) => event.type);
    expect(types).toEqual(['event_update', 'event_update', 'event_delete', 'event_update']);
  });

  it('only enqueues schedule creates for connected owners and deletes for bound tasks', async () => {
    const repository = new MongooseTaskRepository();
    const scope = { tenantId: 'local', ownerId: 'local-user' };
    const disconnectedTask = await TaskModel.create({ title: 'Before connection' });

    await repository.updateSchedule(scope, disconnectedTask.id, 0, {
      dueAt: new Date('2026-08-20T12:00:00.000Z'),
      timeZone: 'Europe/Warsaw',
      durationMinutes: 30,
    });
    await repository.updateSchedule(scope, disconnectedTask.id, 1, null);
    expect(await CalendarOutboxModel.countDocuments()).toBe(0);

    const connection = await CalendarConnectionModel.create({
      ...scope,
      provider: 'google',
      calendarId: 'work',
      credentialRef: `oauth-grant:${new mongoose.Types.ObjectId()}`,
      status: 'active',
    });
    const connectedTask = await TaskModel.create({ title: 'After connection' });
    await repository.updateSchedule(scope, connectedTask.id, 0, {
      dueAt: new Date('2026-08-21T12:00:00.000Z'),
      timeZone: 'Europe/Warsaw',
      durationMinutes: 45,
    });
    await repository.updateSchedule(scope, connectedTask.id, 1, null);
    expect((await CalendarOutboxModel.find().lean()).map((event) => event.type)).toEqual([
      'event_create',
    ]);

    await CalendarBindingModel.create({
      ...scope,
      connectionId: connection._id,
      taskId: connectedTask.id,
      providerEventId: 'event-connected',
      providerEtag: 'etag-connected',
      lastTaskRevision: 2,
      lastProviderRevision: 'etag-connected',
    });
    await repository.updateSchedule(scope, connectedTask.id, 2, {
      dueAt: new Date('2026-08-22T12:00:00.000Z'),
      timeZone: 'Europe/Warsaw',
      durationMinutes: 45,
    });
    await repository.updateSchedule(scope, connectedTask.id, 3, null);
    expect((await CalendarOutboxModel.find().sort({ createdAt: 1 }).lean()).map((event) => event.type)).toEqual([
      'event_create',
      'event_update',
      'event_delete',
    ]);
  });

  it('maps lifecycle repository failures through the HTTP error boundary', async () => {
    const task = await TaskModel.create({ title: 'Lifecycle failure' });
    jest.spyOn(TaskModel, 'findOne').mockReturnValue({
      select: () => ({
        lean: async () => {
          throw new Error('lifecycle failure');
        },
      }),
    } as never);

    const response = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'complete' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('lifecycle failure');
  });

  it('allows final purge only from trash', async () => {
    const task = await TaskModel.create({ title: 'Trash before purge' });

    const rejected = await api.delete(`/tasks/${task.id}`).set('If-Match', '"0"');
    const trashed = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'trash' });
    const purged = await api.delete(`/tasks/${task.id}`).set('If-Match', '"1"');

    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('task_not_trashed');
    expect(trashed.status).toBe(200);
    expect(purged.status).toBe(204);
    await expect(TaskModel.findById(task.id)).resolves.toBeNull();
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
    const trashed = await api
      .put(`/tasks/${first.body._id}/lifecycle`)
      .set('If-Match', `"${first.body.revision}"`)
      .send({ action: 'trash' });
    const deleted = await api
      .delete(`/tasks/${first.body._id}`)
      .set('If-Match', `"${trashed.body.revision}"`);

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
    expect(trashed.status).toBe(200);
    expect(deleted.status).toBe(204);
    expect(replay.status).toBe(410);
    expect(replay.body.code).toBe('idempotency_result_deleted');
    expect(changedReplay.status).toBe(409);
    expect(changedReplay.body.code).toBe('idempotency_key_reused');
    expect(listed.body).toEqual([]);
    await expect(TaskModel.countDocuments({ createOperationId: operationId })).resolves.toBe(1);
    await expect(
      TaskModel.findOne({ createOperationId: operationId }).select(
        '+createOperationDigest +deletedAt'
      )
    ).resolves.toMatchObject({
      title: '[deleted]',
      description: '',
      urgent: false,
      important: false,
      deletedAt: expect.any(Date),
    });
  });

  it('collapses concurrent creates with one operation key to one owner-scoped task', async () => {
    const responses = await Promise.all(
      Array.from({ length: 16 }, () =>
        api
          .post('/tasks')
          .set('Idempotency-Key', 'mobile-concurrent-operation-1')
          .send({ title: 'Concurrent task', description: 'same payload', important: true })
      )
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

    await expect(
      repository.create(
        { tenantId: 'local', ownerId: 'local-user' },
        { title: 'Unreadable create', description: '', urgent: false, important: false },
        { id: 'unreadable-operation', payloadDigest: 'digest' }
      )
    ).rejects.toThrow('Idempotent task create did not return a task');
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

    const createFor = (tenantId: string, ownerId: string) =>
      request(scopedApp)
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

    expect([tenantAOwnerA.status, tenantAOwnerB.status, tenantBOwnerA.status]).toEqual([
      201, 201, 201,
    ]);
    expect(
      new Set([tenantAOwnerA.body._id, tenantAOwnerB.body._id, tenantBOwnerA.body._id]).size
    ).toBe(3);
    await expect(
      TaskModel.countDocuments({ createOperationId: 'shared-operation-key' })
    ).resolves.toBe(3);
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

    const second = await api.get(
      `/tasks?limit=2&cursor=${encodeURIComponent(first.headers['x-next-cursor'])}`
    );
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
      }))
    );

    const first = await api.get('/tasks');

    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(100);
    expect(first.headers['x-next-cursor']).toEqual(expect.any(String));
    expect(first.headers.link).toMatch(/^<\?limit=100&cursor=[^>]+>; rel="next"$/);

    const second = await api.get(
      `/tasks?limit=100&cursor=${encodeURIComponent(first.headers['x-next-cursor'])}`
    );
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
    Buffer.from(JSON.stringify({ id: new mongoose.Types.ObjectId().toString() })).toString(
      'base64url'
    ),
    Buffer.from(
      JSON.stringify({ createdAt: 'not-a-date', id: new mongoose.Types.ObjectId().toString() })
    ).toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: new Date().toISOString() })).toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), id: 'not-an-id' })).toString(
      'base64url'
    ),
  ])('rejects invalid pagination cursor %#', async (cursor) => {
    const response = await api.get(`/tasks?cursor=${encodeURIComponent(cursor)}`);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid task cursor');
  });

  it('uses the default page size when continuing from a cursor without a limit', async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        createdAt: new Date(Date.now() + 60_000).toISOString(),
        id: new mongoose.Types.ObjectId().toString(),
      })
    ).toString('base64url');
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

  it('defines a lifecycle-aware pagination index matching filtered task pages', () => {
    expect(TaskModel.schema.indexes()).toContainEqual([
      { tenantId: 1, ownerId: 1, lifecycleState: 1, createdAt: -1, _id: -1 },
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
    const task = await TaskModel.create({
      title: 'Conditional delete',
      urgent: false,
      important: false,
    });
    const trashed = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'trash' });

    const stale = await api.delete(`/tasks/${task.id}`).set('If-Match', '"0"');
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('task_revision_conflict');

    const current = await api
      .delete(`/tasks/${task.id}`)
      .set('If-Match', `"${trashed.body.revision}"`);
    expect(current.status).toBe(204);
  });

  it('deletes a task', async () => {
    const task = await TaskModel.create({
      title: 'Delete me',
      urgent: false,
      important: false,
    });

    const trashed = await api
      .put(`/tasks/${task.id}/lifecycle`)
      .set('If-Match', '"0"')
      .send({ action: 'trash' });
    const response = await api
      .delete(`/tasks/${task.id}`)
      .set('If-Match', `"${trashed.body.revision}"`);

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
    const task = await TaskModel.create({ title: 'Broken delete', lifecycleState: 'trashed' });
    jest.spyOn(TaskModel, 'findOneAndDelete').mockRejectedValue(new Error('delete failure'));

    const response = await api.delete(`/tasks/${task.id}`).set('If-Match', '"0"');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('delete failure');
  });

  it('returns not found when a trashed task disappears during final purge', async () => {
    const task = await TaskModel.create({ title: 'Purge race', lifecycleState: 'trashed' });
    jest.spyOn(TaskModel, 'findOneAndDelete').mockImplementationOnce((async () => {
      await TaskModel.deleteOne({ _id: task.id });
      return null;
    }) as never);

    const response = await api.delete(`/tasks/${task.id}`).set('If-Match', '"0"');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Task not found');
  });
});
