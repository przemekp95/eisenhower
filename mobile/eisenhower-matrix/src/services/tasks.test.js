import { mobileConfig } from '../config';
import { setAccessToken } from '../authSession';
import {
  createRemoteTask,
  deleteRemoteTask,
  fetchRemoteTasks,
  isRemoteTaskId,
  normalizeRemoteTask,
  updateRemoteTask,
} from './tasks';

describe('tasks service', () => {
  const jsonHeaders = (nextCursor = null) => ({
    get: (name) => {
      if (String(name).toLowerCase() === 'content-type') return 'application/json';
      if (String(name).toLowerCase() === 'x-next-cursor') return nextCursor;
      return null;
    },
  });

  beforeEach(() => {
    global.fetch = jest.fn();
    setAccessToken('test-api-token');
  });

  it('normalizes remote tasks and loads the task list', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: jsonHeaders(),
      json: async () => [
        { _id: '507f1f77bcf86cd799439011', title: 'Remote', description: 'desc', urgent: true, important: false },
      ],
    });

    await expect(fetchRemoteTasks('en')).resolves.toEqual([
      {
        id: '507f1f77bcf86cd799439011',
        title: 'Remote',
        description: 'desc',
        urgent: true,
        important: false,
        locale: 'en',
        remoteId: '507f1f77bcf86cd799439011',
        syncState: 'synced',
        revision: 0,
      },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.apiUrl}/tasks?limit=200`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-api-token' }),
      })
    );
  });

  it('follows bounded task pages until the server omits the next cursor', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: jsonHeaders('cursor-2'),
        json: async () => [{ _id: '507f1f77bcf86cd799439011', title: 'First' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: jsonHeaders(),
        json: async () => [{ _id: '507f1f77bcf86cd799439012', title: 'Second' }],
      });

    await expect(fetchRemoteTasks('pl')).resolves.toHaveLength(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${mobileConfig.apiUrl}/tasks?limit=200`,
      expect.any(Object)
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${mobileConfig.apiUrl}/tasks?limit=200&cursor=cursor-2`,
      expect.any(Object)
    );
  });

  it('fails closed when the server repeats a pagination cursor', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: jsonHeaders('repeated'),
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: jsonHeaders('repeated'),
        json: async () => [],
      });

    await expect(fetchRemoteTasks()).rejects.toThrow('Task pagination cursor repeated');
  });

  it('rejects a non-array task page', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: jsonHeaders(),
      json: async () => ({ tasks: [] }),
    });

    await expect(fetchRemoteTasks()).rejects.toThrow('Task list response must be an array');
  });

  it('fails closed after the bounded maximum number of task pages', async () => {
    let page = 0;
    global.fetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: jsonHeaders(`cursor-${page += 1}`),
      json: async () => [],
    }));

    await expect(fetchRemoteTasks()).rejects.toThrow('Task pagination exceeded the safe page limit');
    expect(global.fetch).toHaveBeenCalledTimes(1000);
  });

  it('creates and updates remote tasks', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: { get: () => 'application/json' },
        json: async () => ({
          _id: '507f1f77bcf86cd799439011',
          title: 'Created',
          description: '',
          urgent: false,
          important: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          _id: '507f1f77bcf86cd799439011',
          title: 'Created',
          description: '',
          urgent: true,
          important: true,
        }),
      });

    await expect(
      createRemoteTask(
        { title: 'Created', description: '', urgent: false, important: true },
        'pl',
        'mobile-create-operation-1'
      )
    ).resolves.toMatchObject({
      id: '507f1f77bcf86cd799439011',
      urgent: false,
      important: true,
    });

    await expect(
      updateRemoteTask('507f1f77bcf86cd799439011', { urgent: true }, 'pl', 0)
    ).resolves.toMatchObject({
      id: '507f1f77bcf86cd799439011',
      urgent: true,
      important: true,
    });

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${mobileConfig.apiUrl}/tasks`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-token',
          'Idempotency-Key': 'mobile-create-operation-1',
        }),
      })
    );
  });

  it('deletes remote tasks and exposes ID helpers', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => '' },
      json: async () => null,
    });

    await expect(deleteRemoteTask('507f1f77bcf86cd799439011', 0)).resolves.toBeUndefined();
    expect(isRemoteTaskId('507f1f77bcf86cd799439011')).toBe(true);
    expect(isRemoteTaskId('local-1')).toBe(false);
    expect(normalizeRemoteTask({ id: '1', title: 'Task', urgent: false, important: false }, 'pl')).toEqual({
      id: '1',
      title: 'Task',
      description: '',
      urgent: false,
      important: false,
      locale: 'pl',
      remoteId: '1',
      syncState: 'synced',
      revision: 0,
    });
  });

  it('preserves revisions and sends If-Match for conflict-safe mutations', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          _id: '507f1f77bcf86cd799439011',
          title: 'Updated',
          urgent: true,
          important: false,
          revision: 4,
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });

    await expect(
      updateRemoteTask('507f1f77bcf86cd799439011', { urgent: true }, 'pl', 3)
    ).resolves.toMatchObject({ revision: 4 });
    await deleteRemoteTask('507f1f77bcf86cd799439011', 4);

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${mobileConfig.apiUrl}/tasks/507f1f77bcf86cd799439011`,
      expect.objectContaining({
        headers: expect.objectContaining({ 'If-Match': '"3"' }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${mobileConfig.apiUrl}/tasks/507f1f77bcf86cd799439011`,
      expect.objectContaining({
        headers: expect.objectContaining({ 'If-Match': '"4"' }),
      })
    );
  });

  it('surfaces backend errors', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'Validation failed' }),
    });

    await expect(fetchRemoteTasks('pl')).rejects.toThrow('Validation failed');
  });

  it('surfaces generic errors for non-json backend responses', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 502,
      headers: { get: () => 'text/plain' },
    });

    await expect(deleteRemoteTask('507f1f77bcf86cd799439011', 0)).rejects.toThrow('Task request failed');
  });

  it('covers default task normalization and optional update fields', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        id: '507f1f77bcf86cd799439014',
        urgent: false,
        important: false,
      }),
    });

    await expect(updateRemoteTask('507f1f77bcf86cd799439014', { title: 'Renamed', description: 'Moved', important: true }, 'pl', 0))
      .resolves.toEqual({
        id: '507f1f77bcf86cd799439014',
        title: '',
        description: '',
        urgent: false,
        important: false,
        locale: 'pl',
        remoteId: '507f1f77bcf86cd799439014',
        syncState: 'synced',
        revision: 0,
      });

    expect(normalizeRemoteTask({ _id: '507f1f77bcf86cd799439015', title: null, description: null, urgent: 0, important: 1 })).toEqual({
      id: '507f1f77bcf86cd799439015',
      title: '',
      description: '',
      urgent: false,
      important: true,
      locale: 'pl',
      remoteId: '507f1f77bcf86cd799439015',
      syncState: 'synced',
      revision: 0,
    });
  });

  it('uses the default locale for list and create calls', async () => {
    const payload = {
      id: '507f1f77bcf86cd799439016',
      title: 'Default locale',
      urgent: false,
      important: true,
    };
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: jsonHeaders(),
        json: async () => [payload],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: { get: () => 'application/json' },
        json: async () => payload,
      });

    await expect(fetchRemoteTasks()).resolves.toEqual([
      expect.objectContaining({ locale: 'pl' }),
    ]);
    await expect(createRemoteTask({ title: 'Default locale' }, 'pl', 'mobile-default-operation')).resolves.toEqual(
      expect.objectContaining({ locale: 'pl' })
    );
  });

  it('fails closed before update or delete when the current revision is missing', async () => {
    await expect(
      updateRemoteTask('507f1f77bcf86cd799439011', { urgent: true })
    ).rejects.toMatchObject({ status: 428, code: 'task_revision_required' });
    await expect(
      deleteRemoteTask('507f1f77bcf86cd799439011')
    ).rejects.toMatchObject({ status: 428, code: 'task_revision_required' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('requires a stable operation id before creating a remote task', async () => {
    await expect(createRemoteTask({ title: 'Unsafe create' }, 'pl')).rejects.toMatchObject({
      status: 400,
      code: 'client_operation_required',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
