import assert from 'node:assert/strict';
import { When } from '@cucumber/cucumber';
import { QUADRANT_DEFINITIONS } from '@eisenhower/api-client';
import request from '../../tests/helpers/http-test-client';
import { EisenhowerWorld } from '../support/world';

const quadrantFlags = Object.fromEntries(
  QUADRANT_DEFINITIONS.map(({ name, urgent, important }) => [name, { urgent, important }]),
) as Record<string, { urgent: boolean; important: boolean }>;

function authenticated(world: EisenhowerWorld) {
  return {
    post: (path: string) => request(world.app).post(path).set('Authorization', 'Bearer test-api-token'),
    put: (path: string) => request(world.app).put(path).set('Authorization', 'Bearer test-api-token'),
  };
}

When('I submit a task without a title', async function (this: EisenhowerWorld) {
  this.response = await authenticated(this).post('/tasks').send({ title: '' });
});

When(
  'I submit a task with a title longer than 200 characters',
  async function (this: EisenhowerWorld) {
    this.response = await authenticated(this).post('/tasks').send({ title: 'x'.repeat(201) });
  },
);

When(
  'I submit a task containing the unexpected field {string}',
  async function (this: EisenhowerWorld, field: string) {
    this.response = await authenticated(this)
      .post('/tasks')
      .send({ title: 'Safe task', [field]: 'unexpected' });
  },
);

When(
  'I try to move a missing task to the {string} quadrant',
  async function (this: EisenhowerWorld, quadrant: string) {
    const flags = quadrantFlags[quadrant];
    assert.ok(flags, `Unknown quadrant: ${quadrant}`);
    this.response = await authenticated(this)
      .put('/tasks/000000000000000000000001')
      .set('If-Match', '"0"')
      .send(flags);
  },
);
