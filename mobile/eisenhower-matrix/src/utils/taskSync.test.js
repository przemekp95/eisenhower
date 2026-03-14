import {
  TASK_SYNC_STATE,
  createPendingTask,
  getTaskRemoteId,
  hasPendingTasks,
  isRemoteTaskId,
  isTaskPendingSync,
  isTaskVisible,
  markTaskPendingDelete,
  markTaskPendingUpdate,
  reconcilePendingTasks,
  normalizeStoredTask,
  normalizeStoredTasks,
  removeTask,
  taskToRemotePayload,
  upsertTask,
} from './taskSync';

describe('taskSync', () => {
  it('detects remote identifiers and normalizes stored tasks', () => {
    expect(isRemoteTaskId('507f1f77bcf86cd799439011')).toBe(true);
    expect(isRemoteTaskId('local-1')).toBe(false);

    expect(
      normalizeStoredTask({
        id: '507f1f77bcf86cd799439011',
        title: ' Remote ',
        description: ' desc ',
        urgent: 1,
        important: 0,
      })
    ).toEqual({
      id: '507f1f77bcf86cd799439011',
      title: 'Remote',
      description: 'desc',
      urgent: true,
      important: false,
      locale: 'pl',
      remoteId: '507f1f77bcf86cd799439011',
      syncState: TASK_SYNC_STATE.synced,
    });
  });

  it('maps local and sample tasks to explicit sync states', () => {
    expect(
      normalizeStoredTask({
        id: 'seed-1',
        title: 'Sample',
        description: '',
        urgent: false,
        important: true,
      })
    ).toMatchObject({
      remoteId: null,
      syncState: TASK_SYNC_STATE.localSeed,
    });

    expect(
      normalizeStoredTask({
        id: 'local-1',
        title: 'Offline',
        description: '',
        urgent: false,
        important: true,
      })
    ).toMatchObject({
      remoteId: null,
      syncState: TASK_SYNC_STATE.pendingCreate,
    });
  });

  it('normalizes invalid sync metadata and empty inputs', () => {
    expect(getTaskRemoteId(null)).toBeNull();
    expect(normalizeStoredTasks(null)).toEqual([]);

    expect(
      normalizeStoredTask({
        id: 'local-1',
        title: 'Offline',
        description: '',
        urgent: false,
        important: true,
        syncState: TASK_SYNC_STATE.synced,
      })
    ).toMatchObject({
      remoteId: null,
      syncState: TASK_SYNC_STATE.pendingCreate,
    });

    expect(
      normalizeStoredTask({
        id: 'seed-1',
        title: 'Sample',
        description: '',
        urgent: false,
        important: true,
        syncState: TASK_SYNC_STATE.pendingDelete,
      })
    ).toMatchObject({
      remoteId: null,
      syncState: TASK_SYNC_STATE.localSeed,
    });
  });

  it('creates, updates and deletes pending tasks', () => {
    const pendingCreateTask = createPendingTask(
      'pl',
      { title: '  Offline ', description: ' task ', urgent: true, important: false },
      'local-1'
    );

    expect(pendingCreateTask).toEqual({
      id: 'local-1',
      title: 'Offline',
      description: 'task',
      urgent: true,
      important: false,
      locale: 'pl',
      remoteId: null,
      syncState: TASK_SYNC_STATE.pendingCreate,
    });

    expect(
      markTaskPendingUpdate(
        {
          id: '507f1f77bcf86cd799439011',
          title: 'Task',
          description: '',
          urgent: false,
          important: false,
          locale: 'pl',
          remoteId: '507f1f77bcf86cd799439011',
          syncState: TASK_SYNC_STATE.synced,
        },
        { urgent: true }
      )
    ).toMatchObject({
      urgent: true,
      syncState: TASK_SYNC_STATE.pendingUpdate,
    });

    expect(
      markTaskPendingUpdate(
        {
          id: 'local-1',
          title: 'Task',
          description: '',
          urgent: false,
          important: false,
          locale: 'pl',
          remoteId: null,
          syncState: TASK_SYNC_STATE.pendingCreate,
        },
        { important: true }
      )
    ).toMatchObject({
      important: true,
      syncState: TASK_SYNC_STATE.pendingCreate,
    });

    expect(
      markTaskPendingDelete({
        id: '507f1f77bcf86cd799439011',
        title: 'Task',
        description: '',
        urgent: false,
        important: false,
        locale: 'pl',
        remoteId: '507f1f77bcf86cd799439011',
        syncState: TASK_SYNC_STATE.synced,
      })
    ).toMatchObject({
      syncState: TASK_SYNC_STATE.pendingDelete,
    });

    expect(
      markTaskPendingDelete({
        id: 'local-1',
        title: 'Task',
        description: '',
        urgent: false,
        important: false,
        locale: 'pl',
        remoteId: null,
        syncState: TASK_SYNC_STATE.pendingCreate,
      })
    ).toBeNull();
  });

  it('tracks visibility, payloads and list reconciliation', () => {
    const remoteTask = normalizeStoredTask({
      id: '507f1f77bcf86cd799439011',
      title: 'Remote',
      description: '',
      urgent: true,
      important: false,
    });
    const pendingDeleteTask = {
      ...remoteTask,
      syncState: TASK_SYNC_STATE.pendingDelete,
    };
    const pendingCreateTask = createPendingTask(
      'pl',
      { title: 'Offline', description: '', urgent: false, important: true },
      'local-2'
    );

    expect(getTaskRemoteId(remoteTask)).toBe('507f1f77bcf86cd799439011');
    expect(getTaskRemoteId(pendingCreateTask)).toBeNull();
    expect(isTaskPendingSync(pendingDeleteTask)).toBe(true);
    expect(isTaskVisible(remoteTask)).toBe(true);
    expect(isTaskVisible(pendingDeleteTask)).toBe(false);
    expect(taskToRemotePayload(pendingCreateTask)).toEqual({
      title: 'Offline',
      description: '',
      urgent: false,
      important: true,
    });
    expect(hasPendingTasks([remoteTask, pendingCreateTask])).toBe(true);
    expect(hasPendingTasks([remoteTask])).toBe(false);

    expect(
      normalizeStoredTasks([remoteTask, pendingCreateTask], 'pl')
    ).toHaveLength(2);

    expect(
      upsertTask([remoteTask], {
        ...remoteTask,
        title: 'Updated',
      })
    ).toEqual([
      {
        ...remoteTask,
        title: 'Updated',
      },
    ]);

    expect(removeTask([remoteTask, pendingCreateTask], pendingCreateTask)).toEqual([
      remoteTask,
    ]);
    expect(removeTask([remoteTask, pendingCreateTask], '507f1f77bcf86cd799439011')).toEqual([
      pendingCreateTask,
    ]);
  });

  it('reconciles pending tasks against the remote API when sync succeeds', async () => {
    const pendingCreateTask = createPendingTask(
      'pl',
      { title: 'Offline', description: 'draft', urgent: false, important: true },
      'local-1'
    );
    const pendingUpdateTask = normalizeStoredTask({
      id: '507f1f77bcf86cd799439012',
      title: 'Update me',
      description: 'refresh',
      urgent: true,
      important: false,
      locale: 'pl',
      remoteId: '507f1f77bcf86cd799439012',
      syncState: TASK_SYNC_STATE.pendingUpdate,
    });
    const pendingDeleteTask = normalizeStoredTask({
      id: '507f1f77bcf86cd799439013',
      title: 'Delete me',
      description: '',
      urgent: false,
      important: false,
      locale: 'pl',
      remoteId: '507f1f77bcf86cd799439013',
      syncState: TASK_SYNC_STATE.pendingDelete,
    });

    const createRemoteTask = jest.fn().mockResolvedValue(
      normalizeStoredTask({
        id: '507f1f77bcf86cd799439021',
        title: 'Offline',
        description: 'draft',
        urgent: false,
        important: true,
      })
    );
    const updateRemoteTask = jest.fn().mockResolvedValue(
      normalizeStoredTask({
        id: '507f1f77bcf86cd799439012',
        title: 'Update me',
        description: 'refresh',
        urgent: true,
        important: false,
      })
    );
    const deleteRemoteTask = jest.fn().mockResolvedValue(undefined);

    const resolvedTasks = await reconcilePendingTasks({
      cachedTasks: [pendingCreateTask, pendingUpdateTask, pendingDeleteTask],
      remoteTasks: [
        normalizeStoredTask({
          id: '507f1f77bcf86cd799439013',
          title: 'Delete me',
          description: '',
          urgent: false,
          important: false,
        }),
      ],
      language: 'pl',
      createRemoteTask,
      updateRemoteTask,
      deleteRemoteTask,
    });

    expect(createRemoteTask).toHaveBeenCalledWith(
      { title: 'Offline', description: 'draft', urgent: false, important: true },
      'pl'
    );
    expect(updateRemoteTask).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439012',
      { title: 'Update me', description: 'refresh', urgent: true, important: false },
      'pl'
    );
    expect(deleteRemoteTask).toHaveBeenCalledWith('507f1f77bcf86cd799439013');
    expect(resolvedTasks).toEqual([
      normalizeStoredTask({
        id: '507f1f77bcf86cd799439012',
        title: 'Update me',
        description: 'refresh',
        urgent: true,
        important: false,
      }),
      normalizeStoredTask({
        id: '507f1f77bcf86cd799439021',
        title: 'Offline',
        description: 'draft',
        urgent: false,
        important: true,
      }),
    ]);
  });

  it('keeps pending tasks when reconciliation fails', async () => {
    const pendingCreateTask = createPendingTask(
      'pl',
      { title: 'Offline', description: 'draft', urgent: false, important: true },
      'local-1'
    );
    const pendingUpdateTask = normalizeStoredTask({
      id: '507f1f77bcf86cd799439012',
      title: 'Update me',
      description: 'refresh',
      urgent: true,
      important: false,
      locale: 'pl',
      remoteId: '507f1f77bcf86cd799439012',
      syncState: TASK_SYNC_STATE.pendingUpdate,
    });
    const pendingDeleteTask = normalizeStoredTask({
      id: '507f1f77bcf86cd799439013',
      title: 'Delete me',
      description: '',
      urgent: false,
      important: false,
      locale: 'pl',
      remoteId: '507f1f77bcf86cd799439013',
      syncState: TASK_SYNC_STATE.pendingDelete,
    });

    const resolvedTasks = await reconcilePendingTasks({
      cachedTasks: [pendingCreateTask, pendingUpdateTask, pendingDeleteTask],
      remoteTasks: [],
      language: 'pl',
      createRemoteTask: jest.fn().mockRejectedValue(new Error('offline')),
      updateRemoteTask: jest.fn().mockRejectedValue(new Error('offline')),
      deleteRemoteTask: jest.fn().mockRejectedValue(new Error('offline')),
    });

    expect(resolvedTasks).toEqual([
      pendingDeleteTask,
      pendingUpdateTask,
      pendingCreateTask,
    ]);
    expect(hasPendingTasks(resolvedTasks)).toBe(true);
  });
});
