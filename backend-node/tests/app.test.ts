import request from 'supertest';
import { createApp } from '../src/app';
import { TaskModel } from '../src/models/task';

describe('app middleware', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('logs non-health requests without query strings', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/missing?from=test');

    expect(response.status).toBe(404);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/^backend-node GET \/missing 404 \d+ms$/));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs server errors for failing non-health routes', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(TaskModel, 'find').mockReturnValue({
      sort: () => ({
        lean: async () => {
          throw new Error('list failure');
        },
      }),
    } as never);

    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/tasks');

    expect(response.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^backend-node GET \/tasks 500 \d+ms$/));
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('skips request logging for health checks', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('skips request logging for readiness checks', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('skips request logging for OPTIONS preflight requests', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp({
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app).options('/tasks');

    expect(response.status).toBe(204);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
