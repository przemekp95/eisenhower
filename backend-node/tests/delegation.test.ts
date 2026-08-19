import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { TaskModel } from '../src/models/task';
import { MongooseTaskRepository } from '../src/repositories/mongooseTaskRepository';
import { createTasksRouter } from '../src/routes/tasks';
import { clearMongo, startMongo, stopMongo } from './helpers/mongo';

function principalApp() {
  const app = express();
  app.use(express.json({ strict: false }));
  app.use((req, _res, next) => {
    req.auth = {
      tenantId: String(req.get('x-test-tenant')),
      userId: String(req.get('x-test-user')),
      roles: ['user'],
      projectIds: [],
    };
    next();
  });
  app.use('/tasks', createTasksRouter());
  return app;
}

function asPrincipal(app: ReturnType<typeof principalApp>, tenantId: string, userId: string) {
  return {
    get: (path: string) => request(app)
      .get(path)
      .set('X-Test-Tenant', tenantId)
      .set('X-Test-User', userId),
    put: (path: string) => request(app)
      .put(path)
      .set('X-Test-Tenant', tenantId)
      .set('X-Test-User', userId),
  };
}

describe('task delegation workflow', () => {
  beforeAll(startMongo);
  afterEach(clearMongo);
  afterAll(stopMongo);

  it('lets an owner offer work and the same-tenant assignee list it without core edit access', async () => {
    const app = principalApp();
    const owner = asPrincipal(app, 'tenant-a', 'owner-a');
    const assignee = asPrincipal(app, 'tenant-a', 'user-b');
    const task = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Prepare handoff',
    });

    const offered = await owner
      .put(`/tasks/${task.id}/delegation`)
      .set('If-Match', '"0"')
      .send({
        delegation: {
          assigneeUserId: 'user-b',
          displayLabel: 'Pat',
          handoffNote: 'Use the approved release checklist.',
        },
      });
    const delegated = await assignee.get('/tasks/delegated');
    const forbiddenCoreEdit = await assignee
      .put(`/tasks/${task.id}`)
      .set('If-Match', '"1"')
      .send({ title: 'Assignee cannot rewrite the owner task' });
    const ownerCoreEdit = await owner
      .put(`/tasks/${task.id}`)
      .set('If-Match', '"1"')
      .send({ title: 'Owner retains task control' });

    expect(offered.status).toBe(200);
    expect(offered.headers.etag).toBe('"1"');
    expect(offered.body.delegation).toMatchObject({
      assigneeUserId: 'user-b',
      displayLabel: 'Pat',
      handoffNote: 'Use the approved release checklist.',
      status: 'offered',
      offeredAt: expect.any(String),
      statusUpdatedAt: expect.any(String),
    });
    expect(delegated.status).toBe(200);
    expect(delegated.body).toHaveLength(1);
    expect(delegated.body[0]._id).toBe(task.id);
    expect(forbiddenCoreEdit.status).toBe(404);
    expect(ownerCoreEdit.status).toBe(200);
  });

  it('enforces assignee status transitions and revision compare-and-swap', async () => {
    const app = principalApp();
    const owner = asPrincipal(app, 'tenant-a', 'owner-a');
    const assignee = asPrincipal(app, 'tenant-a', 'user-b');
    const task = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Revision-safe handoff',
    });
    await owner
      .put(`/tasks/${task.id}/delegation`)
      .set('If-Match', '"0"')
      .send({ delegation: { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '' } });

    const accepted = await assignee
      .put(`/tasks/${task.id}/delegation/status`)
      .set('If-Match', '"1"')
      .send({ status: 'accepted' });
    const stale = await assignee
      .put(`/tasks/${task.id}/delegation/status`)
      .set('If-Match', '"1"')
      .send({ status: 'in_progress' });
    const started = await assignee
      .put(`/tasks/${task.id}/delegation/status`)
      .set('If-Match', '"2"')
      .send({ status: 'in_progress' });
    const invalid = await assignee
      .put(`/tasks/${task.id}/delegation/status`)
      .set('If-Match', '"3"')
      .send({ status: 'accepted' });

    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      revision: 2,
      delegation: { status: 'accepted', acceptedAt: expect.any(String) },
    });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('task_revision_conflict');
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      revision: 3,
      delegation: { status: 'in_progress', inProgressAt: expect.any(String) },
    });
    expect(invalid.status).toBe(409);
    expect(invalid.body.code).toBe('invalid_delegation_transition');
  });

  it('records timestamps across blocked, resumed, completed, and declined workflows', async () => {
    const app = principalApp();
    const owner = asPrincipal(app, 'tenant-a', 'owner-a');
    const assignee = asPrincipal(app, 'tenant-a', 'user-b');
    const first = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Complete delegation',
    });
    const second = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Decline delegation',
    });
    await owner
      .put(`/tasks/${first.id}/delegation`)
      .set('If-Match', '"0"')
      .send({ delegation: { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '' } });
    await owner
      .put(`/tasks/${second.id}/delegation`)
      .set('If-Match', '"0"')
      .send({ delegation: { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '' } });

    const transition = (id: string, revision: number, status: string) => assignee
      .put(`/tasks/${id}/delegation/status`)
      .set('If-Match', `"${revision}"`)
      .send({ status });
    await transition(first.id, 1, 'accepted');
    await transition(first.id, 2, 'in_progress');
    const blocked = await transition(first.id, 3, 'blocked');
    const resumed = await transition(first.id, 4, 'in_progress');
    const completed = await transition(first.id, 5, 'completed');
    const terminal = await transition(first.id, 6, 'blocked');
    const declined = await transition(second.id, 1, 'declined');

    expect(blocked.body.delegation).toMatchObject({
      status: 'blocked', blockedAt: expect.any(String), statusUpdatedAt: expect.any(String),
    });
    expect(resumed.body.delegation).toMatchObject({
      status: 'in_progress', inProgressAt: expect.any(String), statusUpdatedAt: expect.any(String),
    });
    expect(completed.body.delegation).toMatchObject({
      status: 'completed',
      acceptedAt: expect.any(String),
      inProgressAt: expect.any(String),
      blockedAt: expect.any(String),
      completedAt: expect.any(String),
      statusUpdatedAt: expect.any(String),
    });
    expect(terminal.status).toBe(409);
    expect(declined.body.delegation).toMatchObject({
      status: 'declined', declinedAt: expect.any(String), statusUpdatedAt: expect.any(String),
    });
  });

  it('lets only the owner reassign or cancel and removes access from the old assignee', async () => {
    const app = principalApp();
    const owner = asPrincipal(app, 'tenant-a', 'owner-a');
    const firstAssignee = asPrincipal(app, 'tenant-a', 'user-b');
    const secondAssignee = asPrincipal(app, 'tenant-a', 'user-c');
    const task = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Reassign handoff',
    });
    await owner
      .put(`/tasks/${task.id}/delegation`)
      .set('If-Match', '"0"')
      .send({ delegation: { assigneeUserId: 'user-b', displayLabel: 'First', handoffNote: '' } });

    const unauthorizedReassign = await firstAssignee
      .put(`/tasks/${task.id}/delegation`)
      .set('If-Match', '"1"')
      .send({ delegation: { assigneeUserId: 'user-c', displayLabel: 'Second', handoffNote: '' } });
    const staleReassign = await owner
      .put(`/tasks/${task.id}/delegation`)
      .set('If-Match', '"0"')
      .send({ delegation: { assigneeUserId: 'user-c', displayLabel: 'Second', handoffNote: '' } });
    const reassigned = await owner
      .put(`/tasks/${task.id}/delegation`)
      .set('If-Match', '"1"')
      .send({ delegation: { assigneeUserId: 'user-c', displayLabel: 'Second', handoffNote: '' } });
    const firstList = await firstAssignee.get('/tasks/delegated');
    const secondList = await secondAssignee.get('/tasks/delegated');
    const cancelled = await owner
      .put(`/tasks/${task.id}/delegation`)
      .set('If-Match', '"2"')
      .send({ delegation: null });

    expect(unauthorizedReassign.status).toBe(404);
    expect(staleReassign.status).toBe(412);
    expect(staleReassign.body.code).toBe('task_revision_conflict');
    expect(reassigned.body).toMatchObject({
      revision: 2,
      delegation: { assigneeUserId: 'user-c', status: 'offered' },
    });
    expect(firstList.body).toEqual([]);
    expect(secondList.body).toHaveLength(1);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.revision).toBe(3);
    expect(cancelled.body.delegation).toBeUndefined();
    await expect(secondAssignee.get('/tasks/delegated')).resolves.toMatchObject({ body: [] });
  });

  it('keeps delegated work tenant-isolated even when the user id is the same', async () => {
    const app = principalApp();
    const owner = asPrincipal(app, 'tenant-a', 'owner-a');
    const correctTenant = asPrincipal(app, 'tenant-a', 'shared-user');
    const otherTenant = asPrincipal(app, 'tenant-b', 'shared-user');
    const task = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Tenant-private handoff',
    });
    await owner
      .put(`/tasks/${task.id}/delegation`)
      .set('If-Match', '"0"')
      .send({ delegation: { assigneeUserId: 'shared-user', displayLabel: 'Shared', handoffNote: '' } });

    const visible = await correctTenant.get('/tasks/delegated');
    const hidden = await otherTenant.get('/tasks/delegated');
    const rejected = await otherTenant
      .put(`/tasks/${task.id}/delegation/status`)
      .set('If-Match', '"1"')
      .send({ status: 'accepted' });

    expect(visible.body).toHaveLength(1);
    expect(hidden.body).toEqual([]);
    expect(rejected.status).toBe(404);
  });

  it.each([
    { assigneeUserId: '', displayLabel: 'Pat', handoffNote: '' },
    { assigneeUserId: 'user-b', displayLabel: '', handoffNote: '' },
    { assigneeUserId: 'user-b', displayLabel: 'x'.repeat(121), handoffNote: '' },
    { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: 'x'.repeat(1001) },
    { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '', tenantId: 'tenant-b' },
  ])('rejects invalid or caller-scoped delegation payload %#', async (delegation) => {
    const app = principalApp();
    const owner = asPrincipal(app, 'tenant-a', 'owner-a');
    const task = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Validate handoff',
    });

    const response = await owner
      .put(`/tasks/${task.id}/delegation`)
      .set('If-Match', '"0"')
      .send({ delegation });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });

  it('preserves the static same-user workflow', async () => {
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });
    const task = await TaskModel.create({ title: 'Static handoff' });
    const offered = await request(app)
      .put(`/tasks/${task.id}/delegation`)
      .set('Authorization', 'Bearer test-api-token')
      .set('If-Match', '"0"')
      .send({
        delegation: {
          assigneeUserId: 'local-user', displayLabel: 'Local user', handoffNote: '',
        },
      });
    const listed = await request(app)
      .get('/tasks/delegated')
      .set('Authorization', 'Bearer test-api-token');
    const accepted = await request(app)
      .put(`/tasks/${task.id}/delegation/status`)
      .set('Authorization', 'Bearer test-api-token')
      .set('If-Match', '"1"')
      .send({ status: 'accepted' });

    expect(offered.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]._id).toBe(task.id);
    expect(accepted.status).toBe(200);
    expect(accepted.body.delegation.status).toBe('accepted');
  });

  it('filters delegated work by business lifecycle and rejects invalid filters', async () => {
    const app = principalApp();
    const delegation = {
      assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '', status: 'accepted' as const,
      offeredAt: new Date(), statusUpdatedAt: new Date(),
    };
    await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Active handoff',
      lifecycleState: 'active', delegation,
    });
    await TaskModel.collection.insertOne({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Archived handoff',
      urgent: false, important: false, revision: 0,
      lifecycleState: 'archived', archivedAt: new Date(), delegation,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const assignee = asPrincipal(app, 'tenant-a', 'user-b');

    const active = await assignee.get('/tasks/delegated?lifecycle=active');
    const archived = await assignee.get('/tasks/delegated?lifecycle=archived');
    const all = await assignee.get('/tasks/delegated?lifecycle=all');
    const invalid = await assignee.get('/tasks/delegated?lifecycle=technical');

    expect(active.status).toBe(200);
    expect(active.body.map((task: { title: string }) => task.title)).toEqual(['Active handoff']);
    expect(archived.body.map((task: { title: string }) => task.title)).toEqual(['Archived handoff']);
    expect(all.body).toHaveLength(2);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('Invalid lifecycle filter');
  });

  it('applies optional delegation and schedule fields without weakening revision preconditions', async () => {
    const app = principalApp();
    const owner = asPrincipal(app, 'tenant-a', 'owner-a');
    const task = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Optional fields',
    });

    const missingDelegationRevision = await owner
      .put(`/tasks/${task.id}/delegation`)
      .send({ delegation: null });
    const offered = await owner
      .put(`/tasks/${task.id}/delegation`)
      .set('If-Match', '"0"')
      .send({ delegation: { assigneeUserId: 'user-b', displayLabel: 'Pat' } });
    const missingStatusRevision = await asPrincipal(app, 'tenant-a', 'user-b')
      .put(`/tasks/${task.id}/delegation/status`)
      .send({ status: 'accepted' });
    const scheduled = await owner
      .put(`/tasks/${task.id}/schedule`)
      .set('If-Match', '"1"')
      .send({
        schedule: { dueAt: '2026-08-15T12:00:00.000Z', timeZone: 'Europe/Warsaw' },
      });

    expect(missingDelegationRevision.status).toBe(428);
    expect(offered.body.delegation.handoffNote).toBe('');
    expect(missingStatusRevision.status).toBe(428);
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.schedule).toEqual({
      dueAt: '2026-08-15T12:00:00.000Z', timeZone: 'Europe/Warsaw', durationMinutes: 30,
    });
  });

  it('defines an assignee-scoped delegated-work index', () => {
    expect(TaskModel.schema.indexes()).toContainEqual([
      {
        tenantId: 1,
        'delegation.assigneeUserId': 1,
        'delegation.statusUpdatedAt': -1,
        _id: -1,
      },
      expect.any(Object),
    ]);
  });

  it.each([
    null,
    { unexpected: true },
    {},
    { delegation: 'not-an-object' },
  ])('rejects malformed delegation request bodies %#', async (body) => {
    const app = principalApp();
    const call = asPrincipal(app, 'tenant-a', 'owner-a')
      .put(`/tasks/${new TaskModel().id}/delegation`)
      .set('If-Match', '"0"');
    const response = body === null
      ? await call.set('Content-Type', 'application/json').send('null')
      : await call.send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });

  it.each([
    null,
    { status: 'accepted', unexpected: true },
    { status: 'not-a-status' },
  ])('rejects malformed delegation status bodies %#', async (body) => {
    const app = principalApp();
    const call = asPrincipal(app, 'tenant-a', 'user-b')
      .put(`/tasks/${new TaskModel().id}/delegation/status`)
      .set('If-Match', '"0"');
    const response = body === null
      ? await call.set('Content-Type', 'application/json').send('null')
      : await call.send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });

  it.each([
    null,
    { unexpected: true },
    {},
    { schedule: 'not-an-object' },
    {
      schedule: {
        dueAt: '2026-08-15T12:00:00.000Z',
        timeZone: 'Europe/Warsaw',
        remindAt: 'not-an-instant',
      },
    },
  ])('keeps schedule validation errors compatible with the expanded task router %#', async (body) => {
    const app = principalApp();
    const call = asPrincipal(app, 'tenant-a', 'owner-a')
      .put(`/tasks/${new TaskModel().id}/schedule`)
      .set('If-Match', '"0"');
    const response = body === null
      ? await call.set('Content-Type', 'application/json').send('null')
      : await call.send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
  });

  it.each(['listDelegated', 'updateDelegation', 'transitionDelegation', 'updateSchedule'] as const)(
    'passes %s repository failures to the router error boundary',
    async (method) => {
      jest.spyOn(MongooseTaskRepository.prototype, method).mockRejectedValue(
        new Error('repository unavailable')
      );
      const app = principalApp();
      const principal = asPrincipal(app, 'tenant-a', method === 'transitionDelegation' ? 'user-b' : 'owner-a');
      const id = new TaskModel().id;
      const response = method === 'listDelegated'
        ? await principal.get('/tasks/delegated')
        : method === 'transitionDelegation'
          ? await principal.put(`/tasks/${id}/delegation/status`).set('If-Match', '"0"').send({ status: 'accepted' })
          : method === 'updateSchedule'
            ? await principal.put(`/tasks/${id}/schedule`).set('If-Match', '"0"').send({ schedule: null })
            : await principal.put(`/tasks/${id}/delegation`).set('If-Match', '"0"').send({ delegation: null });

      expect(response.status).toBe(500);
    }
  );

  it('treats a legacy delegated task without revision as revision zero', async () => {
    const inserted = await TaskModel.collection.insertOne({
      tenantId: 'tenant-a',
      ownerId: 'owner-a',
      title: 'Legacy delegated task',
      urgent: false,
      important: false,
      lifecycleState: 'active',
      delegation: {
        assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '', status: 'offered',
        offeredAt: new Date(), statusUpdatedAt: new Date(),
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const repository = new MongooseTaskRepository();

    const result = await repository.transitionDelegation(
      { tenantId: 'tenant-a', userId: 'user-b' },
      inserted.insertedId.toString(),
      0,
      'accepted'
    );

    expect(result.status).toBe('updated');
  });

  it('reports a revision conflict when the delegation CAS loses a race', async () => {
    const task = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Concurrent delegation',
      delegation: {
        assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '', status: 'offered',
        offeredAt: new Date(), statusUpdatedAt: new Date(),
      },
    });
    jest.spyOn(TaskModel, 'findOneAndUpdate').mockResolvedValueOnce(null);

    const result = await new MongooseTaskRepository().transitionDelegation(
      { tenantId: 'tenant-a', userId: 'user-b' }, task.id, 0, 'accepted'
    );

    expect(result).toEqual({ status: 'revision_conflict' });
  });
});
