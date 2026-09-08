import request from './helpers/http-test-client';
import { createApp } from '../src/app';
import { TaskRepository } from '../src/application/taskRepository';

describe('application composition root', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('routes task reads through the injected repository', async () => {
    const listPage = jest.fn().mockResolvedValue({ tasks: [], hasNextPage: false });
    const repository = { listPage } as unknown as TaskRepository;
    const app = createApp({
      taskRepository: repository,
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app)
      .get('/tasks')
      .set('Authorization', 'Bearer test-api-token');

    expect(response.status).toBe(200);
    expect(listPage).toHaveBeenCalledWith(
      { tenantId: 'local', ownerId: 'local-user' },
      100,
      undefined,
      'active'
    );
  });

  it('exposes the same task contract through the ALB /api prefix', async () => {
    const listPage = jest.fn().mockResolvedValue({ tasks: [], hasNextPage: false });
    const repository = { listPage } as unknown as TaskRepository;
    const app = createApp({
      taskRepository: repository,
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const response = await request(app)
      .get('/api/tasks')
      .set('Authorization', 'Bearer test-api-token');

    expect(response.status).toBe(200);
    expect(listPage).toHaveBeenCalledWith(
      { tenantId: 'local', ownerId: 'local-user' },
      100,
      undefined,
      'active',
    );
  });

  it('emits one structured request-completion event with release and request correlation', async () => {
    const previousReleaseSha = process.env.RELEASE_SHA;
    process.env.RELEASE_SHA = 'a'.repeat(40);
    const logSink = jest.fn();
    const repository = {
      listPage: jest.fn().mockResolvedValue({ tasks: [], hasNextPage: false }),
    } as unknown as TaskRepository;
    const app = createApp({
      taskRepository: repository,
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
      logSink,
    });

    const response = await request(app)
      .get('/api/tasks?lifecycle=active')
      .set('Authorization', 'Bearer test-api-token')
      .set('X-Request-ID', 'request-123');

    expect(response.status).toBe(200);

    expect(logSink).toHaveBeenCalledTimes(1);
    expect(logSink).toHaveBeenCalledWith('info', expect.objectContaining({
      event: 'http_request_completed',
      service: 'backend-node',
      releaseSha: 'a'.repeat(40),
      requestId: 'request-123',
      method: 'GET',
      path: '/api/tasks',
      statusCode: 200,
      durationMs: expect.any(Number),
    }));
    if (previousReleaseSha === undefined) delete process.env.RELEASE_SHA;
    else process.env.RELEASE_SHA = previousReleaseSha;
  });
});
