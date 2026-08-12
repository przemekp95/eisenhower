import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { QUADRANT_DEFINITIONS } from '@eisenhower/api-client';
import request from 'supertest';
import { TaskModel } from '../../src/models/task';
import { EisenhowerWorld } from '../support/world';

type Quadrant = 'Do Now' | 'Delegate' | 'Schedule' | 'Delete';

const quadrants = Object.fromEntries(
  QUADRANT_DEFINITIONS.map(({ name, urgent, important }) => [name, { urgent, important }]),
) as Record<Quadrant, { urgent: boolean; important: boolean }>;

function quadrantNamed(value: string) {
  assert.ok(value in quadrants, `Unknown quadrant: ${value}`);
  return quadrants[value as Quadrant];
}

function authenticated(world: EisenhowerWorld) {
  return {
    get: (path: string) => request(world.app).get(path).set('Authorization', 'Bearer test-api-token'),
    post: (path: string) => request(world.app).post(path).set('Authorization', 'Bearer test-api-token'),
    put: (path: string) => request(world.app).put(path).set('Authorization', 'Bearer test-api-token'),
    delete: (path: string) => request(world.app).delete(path).set('Authorization', 'Bearer test-api-token'),
  };
}

Given(
  'my task {string} is in the {string} quadrant',
  async function (this: EisenhowerWorld, title: string, quadrant: string) {
    const task = await TaskModel.create({ title, ...quadrantNamed(quadrant) });
    this.taskId = task.id;
    this.taskRevision = task.revision;
  },
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
  },
);

When(
  'I create the task {string} in the {string} quadrant',
  async function (this: EisenhowerWorld, title: string, quadrant: string) {
    this.response = await authenticated(this)
      .post('/tasks')
      .send({ title, ...quadrantNamed(quadrant) });
    this.taskId = this.response.body._id;
    this.taskRevision = this.response.body.revision;
  },
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
  },
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
  },
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
  "I try to move the other tenant's task to the {string} quadrant",
  async function (this: EisenhowerWorld, quadrant: string) {
    assert.ok(this.taskId, 'The other tenant task must exist before it can be moved');
    this.response = await authenticated(this)
      .put(`/tasks/${this.taskId}`)
      .set('If-Match', '"0"')
      .send(quadrantNamed(quadrant));
  },
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
  },
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
      quadrantNamed(quadrant),
    );
  },
);

Then(
  'my task list contains {string} in the {string} quadrant',
  function (this: EisenhowerWorld, title: string, quadrant: string) {
    assert.ok(this.response, 'A task-list response must exist');
    assert.equal(this.response.status, 200);
    const task = this.response.body.find((candidate: { title: string }) => candidate.title === title);
    assert.ok(task, `Task not found in list: ${title}`);
    assert.deepEqual(
      { urgent: task.urgent, important: task.important },
      quadrantNamed(quadrant),
    );
  },
);

Then(
  'my task list does not contain {string}',
  function (this: EisenhowerWorld, title: string) {
    assert.ok(this.response, 'A task-list response must exist');
    assert.equal(this.response.status, 200);
    assert.equal(
      this.response.body.some((candidate: { title: string }) => candidate.title === title),
      false,
    );
  },
);
