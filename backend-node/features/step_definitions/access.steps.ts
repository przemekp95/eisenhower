import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import request from '../../tests/helpers/http-test-client';
import { createApp } from '../../src/app';
import { TaskModel } from '../../src/models/task';
import { EisenhowerWorld } from '../support/world';

Given(
  'the configured browser origin is {string}',
  function (this: EisenhowerWorld, origin: string) {
    process.env.CORS_ALLOW_ORIGINS = origin;
    this.app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });
  },
);

When('I list tasks without bearer credentials', async function (this: EisenhowerWorld) {
  this.response = await request(this.app).get('/tasks');
});

When(
  'I list tasks with bearer token {string}',
  async function (this: EisenhowerWorld, token: string) {
    this.response = await request(this.app)
      .get('/tasks')
      .set('Authorization', `Bearer ${token}`);
  },
);

When(
  'a browser from {string} creates the task {string}',
  async function (this: EisenhowerWorld, origin: string, title: string) {
    this.response = await request(this.app)
      .post('/tasks')
      .set('Authorization', 'Bearer test-api-token')
      .set('Origin', origin)
      .send({ title });
  },
);

Then(
  'the request fails with status {int} and error {string}',
  function (this: EisenhowerWorld, expectedStatus: number, expectedError: string) {
    assert.ok(this.response, 'A request must be made before its error is checked');
    assert.equal(this.response.status, expectedStatus);
    assert.equal(this.response.body.error, expectedError);
  },
);

Then('the response advertises bearer authentication', function (this: EisenhowerWorld) {
  assert.ok(this.response, 'An authentication response must exist');
  assert.equal(this.response.headers['www-authenticate'], 'Bearer');
});

Then('the response advertises an invalid bearer token', function (this: EisenhowerWorld) {
  assert.ok(this.response, 'An authentication response must exist');
  assert.equal(this.response.headers['www-authenticate'], 'Bearer error="invalid_token"');
});

Then(
  'the validation details include {string}',
  function (this: EisenhowerWorld, expectedDetail: string) {
    assert.ok(this.response, 'A validation response must exist');
    assert.ok(this.response.body.details.includes(expectedDetail));
  },
);

Then('no task named {string} exists', async function (title: string) {
  assert.equal(await TaskModel.countDocuments({ title }), 0);
});
