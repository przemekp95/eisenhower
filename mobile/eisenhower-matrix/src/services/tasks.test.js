import { mobileConfig } from '../config';
import {
  createRemoteTask,
  deleteRemoteTask,
  fetchRemoteTasks,
  isRemoteTaskId,
  normalizeRemoteTask,
  updateRemoteTask,
} from './tasks';

describe('tasks service', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('normalizes remote tasks and loads the task list', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
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
      },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(`${mobileConfig.apiUrl}/tasks`);
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
      createRemoteTask({ title: 'Created', description: '', urgent: false, important: true }, 'pl')
    ).resolves.toMatchObject({
      id: '507f1f77bcf86cd799439011',
      urgent: false,
      important: true,
    });

    await expect(
      updateRemoteTask('507f1f77bcf86cd799439011', { urgent: true }, 'pl')
    ).resolves.toMatchObject({
      id: '507f1f77bcf86cd799439011',
      urgent: true,
      important: true,
    });
  });

  it('deletes remote tasks and exposes ID helpers', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => '' },
      json: async () => null,
    });

    await expect(deleteRemoteTask('507f1f77bcf86cd799439011')).resolves.toBeUndefined();
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
    });
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

    await expect(deleteRemoteTask('507f1f77bcf86cd799439011')).rejects.toThrow('Task request failed');
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

    await expect(updateRemoteTask('507f1f77bcf86cd799439014', { title: 'Renamed', description: 'Moved', important: true }))
      .resolves.toEqual({
        id: '507f1f77bcf86cd799439014',
        title: '',
        description: '',
        urgent: false,
        important: false,
        locale: 'pl',
        remoteId: '507f1f77bcf86cd799439014',
        syncState: 'synced',
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
    });
  });
});
