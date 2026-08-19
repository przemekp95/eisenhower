import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { QUADRANT_DEFINITIONS } from '@eisenhower/api-client';
import express from 'express';
import request, { Test } from 'supertest';
import { TaskModel } from '../../src/models/task';
import { createTasksRouter } from '../../src/routes/tasks';
import { EisenhowerWorld } from '../support/world';

type Quadrant = 'Do Now' | 'Delegate' | 'Schedule' | 'Delete';

const quadrants = Object.fromEntries(
  QUADRANT_DEFINITIONS.map(({ name, urgent, important }) => [name, { urgent, important }])
) as Record<Quadrant, { urgent: boolean; important: boolean }>;

function quadrantNamed(value: string) {
  assert.ok(value in quadrants, `Unknown quadrant: ${value}`);
  return quadrants[value as Quadrant];
}

function authenticated(world: EisenhowerWorld) {
  const withPrincipal = (testRequest: Test) => testRequest
    .set('X-Test-Tenant', world.actorTenantId)
    .set('X-Test-User', world.actorUserId);
  return {
    get: (path: string) => withPrincipal(
      request(world.app).get(path).set('Authorization', 'Bearer test-api-token'),
    ),
    post: (path: string) => withPrincipal(
      request(world.app).post(path).set('Authorization', 'Bearer test-api-token'),
    ),
    put: (path: string) => withPrincipal(
      request(world.app).put(path).set('Authorization', 'Bearer test-api-token'),
    ),
    delete: (path: string) => withPrincipal(
      request(world.app).delete(path).set('Authorization', 'Bearer test-api-token'),
    ),
  };
}

function useInjectedPrincipalRouter(world: EisenhowerWorld) {
  const app = express();
  app.use(express.json());
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
  world.app = app;
}

Given(
  'my task {string} is in the {string} quadrant',
  async function (this: EisenhowerWorld, title: string, quadrant: string) {
    const task = await TaskModel.create({ title, ...quadrantNamed(quadrant) });
    this.taskId = task.id;
    this.taskRevision = task.revision;
  }
);

Given(
  'another tenant has a task named {string}',
  async function (this: EisenhowerWorld, title: string) {
    const task = await TaskModel.create({
      tenantId: 'another-tenant',
      ownerId: 'another-user',
      title,
      urgent: true,
      important: true,
    });
    this.taskId = task.id;
  }
);

Given(
  'owner {string} has a task {string} for delegation',
  async function (this: EisenhowerWorld, ownerId: string, title: string) {
    useInjectedPrincipalRouter(this);
    this.actorTenantId = 'tenant-a';
    this.actorUserId = ownerId;
    const task = await TaskModel.create({ tenantId: 'tenant-a', ownerId, title });
    this.taskId = task.id;
    this.taskRevision = task.revision;
  }
);

When(
  'I create the task {string} in the {string} quadrant',
  async function (this: EisenhowerWorld, title: string, quadrant: string) {
    this.response = await authenticated(this)
      .post('/tasks')
      .send({ title, ...quadrantNamed(quadrant) });
    this.taskId = this.response.body._id;
    this.taskRevision = this.response.body.revision;
  }
);

When(
  'I retry creating the task {string} twice with operation key {string}',
  async function (this: EisenhowerWorld, title: string, operationKey: string) {
    const first = await authenticated(this)
      .post('/tasks')
      .set('Idempotency-Key', operationKey)
      .send({ title, ...quadrantNamed('Schedule') });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    this.response = await authenticated(this)
      .post('/tasks')
      .set('Idempotency-Key', operationKey)
      .send({ title, ...quadrantNamed('Schedule') });
  }
);

When('I list my tasks', async function (this: EisenhowerWorld) {
  this.response = await authenticated(this).get('/tasks');
});

When(
  'I move the task to the {string} quadrant',
  async function (this: EisenhowerWorld, quadrant: string) {
    assert.ok(this.taskId, 'A task must exist before it can be moved');
    assert.ok(Number.isInteger(this.taskRevision), 'The current revision must be available');
    this.response = await authenticated(this)
      .put(`/tasks/${this.taskId}`)
      .set('If-Match', `"${this.taskRevision}"`)
      .send(quadrantNamed(quadrant));
    this.taskRevision = this.response.body.revision;
  }
);

When(
  'I rename the task to {string} and describe it as {string}',
  async function (this: EisenhowerWorld, title: string, description: string) {
    assert.ok(this.taskId, 'A task must exist before it can be edited');
    assert.ok(Number.isInteger(this.taskRevision), 'The current revision must be available');
    this.response = await authenticated(this)
      .put(`/tasks/${this.taskId}`)
      .set('If-Match', `"${this.taskRevision}"`)
      .send({ title, description });
    this.taskRevision = this.response.body.revision;
  },
);

Given(
  'someone else renames the task to {string}',
  async function (this: EisenhowerWorld, title: string) {
    assert.ok(this.taskId, 'A task must exist before it can be changed elsewhere');
    assert.ok(Number.isInteger(this.taskRevision), 'The current revision must be available');
    const response = await authenticated(this)
      .put(`/tasks/${this.taskId}`)
      .set('If-Match', `"${this.taskRevision}"`)
      .send({ title });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  },
);

When(
  'I try to rename my older version to {string}',
  async function (this: EisenhowerWorld, title: string) {
    assert.ok(this.taskId, 'A task must exist before it can be edited');
    assert.ok(Number.isInteger(this.taskRevision), 'The older revision must be available');
    this.response = await authenticated(this)
      .put(`/tasks/${this.taskId}`)
      .set('If-Match', `"${this.taskRevision}"`)
      .send({ title });
  },
);

When('I delete the task', async function (this: EisenhowerWorld) {
  assert.ok(this.taskId, 'A task must exist before it can be deleted');
  assert.ok(Number.isInteger(this.taskRevision), 'The current revision must be available');
  this.response = await authenticated(this)
    .delete(`/tasks/${this.taskId}`)
    .set('If-Match', `"${this.taskRevision}"`);
});

When(
  'I change the task lifecycle with action {string}',
  async function (this: EisenhowerWorld, action: string) {
    assert.ok(this.taskId, 'A task must exist before its lifecycle can change');
    assert.ok(Number.isInteger(this.taskRevision), 'The current revision must be available');
    this.response = await authenticated(this)
      .put(`/tasks/${this.taskId}/lifecycle`)
      .set('If-Match', `"${this.taskRevision}"`)
      .send({ action });
    if (this.response.status === 200) {
      this.taskRevision = this.response.body.revision;
    }
  }
);

When(
  'I schedule it for {string} in {string} with reminder {string}',
  async function (this: EisenhowerWorld, dueAt: string, timeZone: string, remindAt: string) {
    assert.ok(this.taskId, 'A task must exist before it can be scheduled');
    assert.ok(Number.isInteger(this.taskRevision), 'The current revision must be available');
    this.response = await authenticated(this)
      .put(`/tasks/${this.taskId}/schedule`)
      .set('If-Match', `"${this.taskRevision}"`)
      .send({ schedule: { dueAt, timeZone, remindAt } });
    if (this.response.status === 200) this.taskRevision = this.response.body.revision;
  }
);

When('I clear the task schedule', async function (this: EisenhowerWorld) {
  assert.ok(this.taskId, 'A task must exist before its schedule can be cleared');
  assert.ok(Number.isInteger(this.taskRevision), 'The current revision must be available');
  this.response = await authenticated(this)
    .put(`/tasks/${this.taskId}/schedule`)
    .set('If-Match', `"${this.taskRevision}"`)
    .send({ schedule: null });
  if (this.response.status === 200) this.taskRevision = this.response.body.revision;
});

When(
  'the owner offers it to assignee {string} labelled {string}',
  async function (this: EisenhowerWorld, assigneeUserId: string, displayLabel: string) {
    assert.ok(this.taskId, 'A task must exist before delegation');
    this.response = await authenticated(this)
      .put(`/tasks/${this.taskId}/delegation`)
      .set('If-Match', `"${this.taskRevision}"`)
      .send({ delegation: { assigneeUserId, displayLabel, handoffNote: 'Use the release runbook.' } });
    if (this.response.status === 200) this.taskRevision = this.response.body.revision;
  }
);

When(
  'assignee {string} lists delegated work',
  async function (this: EisenhowerWorld, assigneeUserId: string) {
    this.actorUserId = assigneeUserId;
    this.response = await authenticated(this).get('/tasks/delegated');
  }
);

When('the assignee accepts the delegated task', async function (this: EisenhowerWorld) {
  assert.ok(this.taskId, 'A delegated task must exist');
  this.response = await authenticated(this)
    .put(`/tasks/${this.taskId}/delegation/status`)
    .set('If-Match', `"${this.taskRevision}"`)
    .send({ status: 'accepted' });
  if (this.response.status === 200) this.taskRevision = this.response.body.revision;
});

When('the assignee tries to rename the owner task', async function (this: EisenhowerWorld) {
  assert.ok(this.taskId, 'A delegated task must exist');
  this.response = await authenticated(this)
    .put(`/tasks/${this.taskId}`)
    .set('If-Match', `"${this.taskRevision}"`)
    .send({ title: 'Unauthorized assignee edit' });
});

When(
  "I try to move the other tenant's task to the {string} quadrant",
  async function (this: EisenhowerWorld, quadrant: string) {
    assert.ok(this.taskId, 'The other tenant task must exist before it can be moved');
    this.response = await authenticated(this)
      .put(`/tasks/${this.taskId}`)
      .set('If-Match', '"0"')
      .send(quadrantNamed(quadrant));
  }
);

When("I try to delete the other tenant's task", async function (this: EisenhowerWorld) {
  assert.ok(this.taskId, 'The other tenant task must exist before it can be deleted');
  this.response = await authenticated(this).delete(`/tasks/${this.taskId}`).set('If-Match', '"0"');
});

Then(
  'the request succeeds with status {int}',
  function (this: EisenhowerWorld, expectedStatus: number) {
    assert.ok(this.response, 'A request must be made before its status is checked');
    assert.equal(this.response.status, expectedStatus, JSON.stringify(this.response.body));
  }
);

Then('exactly one task named {string} exists', async function (title: string) {
  assert.equal(await TaskModel.countDocuments({ title }), 1);
});

Then('the request fails as not found', function (this: EisenhowerWorld) {
  assert.ok(this.response, 'A request must be made before its status is checked');
  assert.equal(this.response.status, 404);
  assert.equal(this.response.body.error, 'Task not found');
});

Then('the request fails because the task changed', function (this: EisenhowerWorld) {
  assert.ok(this.response, 'A request must be made before its status is checked');
  assert.equal(this.response.status, 412);
  assert.equal(this.response.body.code, 'task_revision_conflict');
});

Then(
  'the returned task is named {string} with description {string}',
  function (this: EisenhowerWorld, title: string, description: string) {
    assert.ok(this.response, 'A task response must exist');
    assert.equal(this.response.body.title, title);
    assert.equal(this.response.body.description, description);
  },
);

Then(
  'the task is still named {string}',
  async function (this: EisenhowerWorld, title: string) {
    assert.ok(this.taskId, 'The task id must be available');
    const task = await TaskModel.findById(this.taskId);
    assert.equal(task?.title, title);
  },
);

Then('the request fails because the task is not trashed', function (this: EisenhowerWorld) {
  assert.ok(this.response, 'A request must be made before its status is checked');
  assert.equal(this.response.status, 409);
  assert.equal(this.response.body.code, 'task_not_trashed');
});

Then(
  'the returned task lifecycle is {string}',
  function (this: EisenhowerWorld, lifecycleState: string) {
    assert.ok(this.response, 'A task response must exist');
    assert.equal(this.response.body.lifecycleState, lifecycleState);
  }
);

Then(
  'the returned schedule is due {string} in {string} for {int} minutes with reminder {string}',
  function (
    this: EisenhowerWorld,
    dueAt: string,
    timeZone: string,
    durationMinutes: number,
    remindAt: string
  ) {
    assert.ok(this.response, 'A task response must exist');
    assert.deepEqual(this.response.body.schedule, { dueAt, timeZone, durationMinutes, remindAt });
  }
);

Then('the returned task has no schedule', function (this: EisenhowerWorld) {
  assert.ok(this.response, 'A task response must exist');
  assert.equal(this.response.body.schedule, undefined);
});

Then(
  'the returned delegation status is {string}',
  function (this: EisenhowerWorld, status: string) {
    assert.ok(this.response, 'A delegation response must exist');
    assert.equal(this.response.status, 200, JSON.stringify(this.response.body));
    assert.equal(this.response.body.delegation.status, status);
  }
);

Then(
  'the delegated task list contains {string}',
  function (this: EisenhowerWorld, title: string) {
    assert.ok(this.response, 'A delegated task list must exist');
    assert.equal(this.response.status, 200, JSON.stringify(this.response.body));
    assert.ok(this.response.body.some((task: { title: string }) => task.title === title));
  },
);

Then("the other tenant's task still exists", async function (this: EisenhowerWorld) {
  assert.ok(this.taskId, 'The other tenant task id must be available');
  assert.ok(await TaskModel.findById(this.taskId));
});

Then(
  'the returned task is in the {string} quadrant',
  function (this: EisenhowerWorld, quadrant: string) {
    assert.ok(this.response, 'A task response must exist');
    assert.deepEqual(
      { urgent: this.response.body.urgent, important: this.response.body.important },
      quadrantNamed(quadrant)
    );
  }
);

Then(
  'my task list contains {string} in the {string} quadrant',
  function (this: EisenhowerWorld, title: string, quadrant: string) {
    assert.ok(this.response, 'A task-list response must exist');
    assert.equal(this.response.status, 200);
    const task = this.response.body.find(
      (candidate: { title: string }) => candidate.title === title
    );
    assert.ok(task, `Task not found in list: ${title}`);
    assert.deepEqual({ urgent: task.urgent, important: task.important }, quadrantNamed(quadrant));
  }
);

Then('my task list does not contain {string}', function (this: EisenhowerWorld, title: string) {
  assert.ok(this.response, 'A task-list response must exist');
  assert.equal(this.response.status, 200);
  assert.equal(
    this.response.body.some((candidate: { title: string }) => candidate.title === title),
    false
  );
});
