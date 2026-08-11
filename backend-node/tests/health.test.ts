import request from 'supertest';
import * as dbModule from '../src/db';
import { createApp, defaultAiHealthChecker } from '../src/app';

describe('health routes', () => {
  it('returns a liveness response even when dependencies are degraded', async () => {
    const app = createApp({
      aiHealthChecker: async () => 'unreachable',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('returns ready only when both db and ai are healthy', async () => {
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
  });

  it('returns not_ready when the database is disconnected', async () => {
    const app = createApp({
      aiHealthChecker: async () => 'unreachable',
      databaseStatusResolver: () => 'disconnected',
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'not_ready' });
  });

  it('returns not_ready when the ai dependency is unhealthy', async () => {
    const app = createApp({
      aiHealthChecker: async () => 'unreachable',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'not_ready' });
  });

  it('does not call dependency checkers during liveness', async () => {
    const app = createApp({
      aiHealthChecker: async () => {
        throw new Error('boom');
      },
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('returns 500 from readiness when dependency checks throw unexpectedly', async () => {
    const app = createApp({
      aiHealthChecker: async () => {
        throw new Error('boom');
      },
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('boom');
  });

  it('maps upstream fetch failures to unreachable', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network down'));

    await expect(defaultAiHealthChecker('http://example')).resolves.toBe('unreachable');
    expect(fetchMock).toHaveBeenCalledWith('http://example/health/ready', {
      headers: { Accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
  });

  it('bounds a stalled AI readiness request with an abort signal', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));

    const startedAt = Date.now();
    await expect(defaultAiHealthChecker('http://example/', 10)).resolves.toBe('unreachable');
    expect(Date.now() - startedAt).toBeLessThan(500);
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
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/health/ready', {
      headers: { Accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
  });

  it('uses default health dependencies when not overridden', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    jest.spyOn(dbModule, 'getDatabaseStatus').mockReturnValue('connected');

    const app = createApp();
    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
  });
});
