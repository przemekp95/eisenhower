import request from 'supertest';
import * as dbModule from '../src/db';
import { createApp, defaultAiHealthChecker } from '../src/app';

describe('health routes', () => {
  it('returns healthy when db is connected', async () => {
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('healthy');
    expect(response.body.services).toEqual({
      database: 'connected',
      ai: 'healthy',
    });
  });

  it('returns unhealthy when db is disconnected', async () => {
    const app = createApp({
      aiHealthChecker: async () => 'unreachable',
      databaseStatusResolver: () => 'disconnected',
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('unhealthy');
    expect(response.body.services.ai).toBe('unreachable');
  });

  it('returns 500 on unexpected checker failures', async () => {
    const app = createApp({
      aiHealthChecker: async () => {
        throw new Error('boom');
      },
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('boom');
  });

  it('maps upstream fetch failures to unreachable', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network down'));

    await expect(defaultAiHealthChecker('http://example')).resolves.toBe('unreachable');
    expect(fetchMock).toHaveBeenCalledWith('http://example', {
      headers: { Accept: 'application/json' },
    });
  });

  it('maps non-ok upstream responses to unhealthy', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
    } as Response);

    await expect(defaultAiHealthChecker('http://example')).resolves.toBe('unhealthy');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the default configured AI url when no url override is provided', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
    } as Response);

    await expect(defaultAiHealthChecker()).resolves.toBe('healthy');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000', {
      headers: { Accept: 'application/json' },
    });
  });

  it('uses default health dependencies when not overridden', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    jest.spyOn(dbModule, 'getDatabaseStatus').mockReturnValue('connected');

    const app = createApp();
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('healthy');
    expect(response.body.services).toEqual({
      database: 'connected',
      ai: 'healthy',
    });
  });
});
