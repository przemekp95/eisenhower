import request from 'supertest';
import { isHealthResponseDto, isTaskDto } from '@eisenhower/api-client';
import { createApp } from '../src/app';
import { clearMongo, startMongo, stopMongo } from './helpers/mongo';

describe('shared API contracts', () => {
  const app = createApp({
    aiHealthChecker: async () => 'healthy',
    databaseStatusResolver: () => 'connected',
  });

  beforeAll(async () => {
    await startMongo();
  });

  afterEach(async () => {
    await clearMongo();
  });

  afterAll(async () => {
    await stopMongo();
  });

  it('returns task payloads that match the shared task dto', async () => {
    const created = await request(app).post('/tasks').send({
      title: 'Plan release',
      description: 'contract coverage',
      urgent: true,
      important: true,
    });

    expect(created.status).toBe(201);
    expect(isTaskDto(created.body)).toBe(true);

    const list = await request(app).get('/tasks');

    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.every((task: unknown) => isTaskDto(task))).toBe(true);
  });

  it('returns health payloads that match the shared health dto', async () => {
    const live = await request(app).get('/health');
    const ready = await request(app).get('/health/ready');

    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(isHealthResponseDto(live.body)).toBe(true);
    expect(isHealthResponseDto(ready.body)).toBe(true);
    expect(ready.body.status).toBe('ready');
  });
});
