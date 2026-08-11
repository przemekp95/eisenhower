import {
  TASK_SYNC_STATE,
  createPendingTask,
  getTaskRemoteId,
  hasPendingTasks,
  isRemoteTaskId,
  isTaskPendingSync,
  isTaskVisible,
  markTaskPendingDelete,
  markTaskSyncFailed,
  markTaskPendingUpdate,
  reconcilePendingTasks,
  normalizeStoredTask,
  normalizeStoredTasks,
  removeTask,
  resolveTaskConflict,
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
    expect(isRemoteTaskId()).toBe(false);
    expect(getTaskRemoteId(null)).toBeNull();
    expect(getTaskRemoteId({ id: 'local-blank', remoteId: '   ' })).toBeNull();
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

    expect(
      normalizeStoredTask({
        id: 'local-update',
        title: 'Unsaved update',
        syncState: TASK_SYNC_STATE.pendingUpdate,
      })
    ).toMatchObject({ syncState: TASK_SYNC_STATE.pendingCreate });
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

    expect(markTaskPendingUpdate(pendingCreateTask)).toMatchObject({
      title: 'Offline',
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

  it('keeps pending changes and distinguishes conflicts from transport failures', () => {
    const task = normalizeStoredTask({
      id: '507f1f77bcf86cd799439011',
      title: 'Remote',
      urgent: true,
      important: false,
      syncState: TASK_SYNC_STATE.pendingUpdate,
    });

    expect(markTaskSyncFailed(task, { status: 412 })).toMatchObject({
      syncState: TASK_SYNC_STATE.pendingUpdate,
      syncError: 'conflict',
    });
    expect(markTaskSyncFailed(task, { response: { status: 409 } })).toMatchObject({
      syncError: 'conflict',
    });
    expect(markTaskSyncFailed(task, new Error('offline'))).toMatchObject({
      syncState: TASK_SYNC_STATE.pendingUpdate,
      syncError: 'error',
    });
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
      { ...pendingDeleteTask, syncError: 'error' },
      { ...pendingUpdateTask, syncError: 'error' },
      { ...pendingCreateTask, syncError: 'error' },
    ]);
    expect(hasPendingTasks(resolvedTasks)).toBe(true);
  });

  it('uses revisions during default-language reconciliation and remote identity matching', async () => {
    const remoteId = '507f1f77bcf86cd799439099';
    const pendingUpdate = normalizeStoredTask({
      id: 'local-alias',
      remoteId,
      title: 'Revision update',
      revision: 7,
      syncState: TASK_SYNC_STATE.pendingUpdate,
    });
    const pendingDelete = normalizeStoredTask({
      id: remoteId,
      title: 'Revision delete',
      revision: 8,
      syncState: TASK_SYNC_STATE.pendingDelete,
    });
    const updateRemoteTask = jest.fn().mockResolvedValue({
      ...pendingUpdate,
      id: remoteId,
      syncState: TASK_SYNC_STATE.synced,
      revision: 8,
    });
    const deleteRemoteTask = jest.fn().mockRejectedValue({ response: { status: 412 } });

    const resolved = await reconcilePendingTasks({
      cachedTasks: [pendingUpdate, pendingDelete],
      remoteTasks: [{ ...pendingUpdate, id: remoteId, title: 'Old remote' }],
      createRemoteTask: jest.fn(),
      updateRemoteTask,
      deleteRemoteTask,
    });

    expect(updateRemoteTask).toHaveBeenCalledWith(
      remoteId,
      expect.objectContaining({ title: 'Revision update' }),
      'pl',
      7
    );
    expect(deleteRemoteTask).toHaveBeenCalledWith(remoteId, 8);
    expect(resolved).toEqual([
      expect.objectContaining({
        title: 'Revision update',
        revision: 8,
        syncState: TASK_SYNC_STATE.conflict,
        syncError: 'conflict',
        pendingIntent: { type: 'delete', baseRevision: 8 },
      }),
    ]);

    expect(
      upsertTask(
        [{ id: 'old-local-id', remoteId, title: 'Old' }],
        { id: 'new-local-id', remoteId, title: 'New' }
      )
    ).toEqual([{ id: 'new-local-id', remoteId, title: 'New' }]);
  });

  it('keeps the fresh remote revision visible on 412 update and preserves local intent', async () => {
    const remoteId = '507f1f77bcf86cd799439081';
    const cached = normalizeStoredTask({
      id: remoteId,
      title: 'My offline edit',
      description: 'local intent',
      urgent: true,
      important: false,
      revision: 7,
      syncState: TASK_SYNC_STATE.pendingUpdate,
    });
    const freshRemote = normalizeStoredTask({
      id: remoteId,
      title: 'New server value',
      description: 'changed elsewhere',
      urgent: false,
      important: true,
      revision: 8,
    });

    const [conflict] = await reconcilePendingTasks({
      cachedTasks: [cached],
      remoteTasks: [freshRemote],
      updateRemoteTask: jest.fn().mockRejectedValue({ status: 412 }),
      createRemoteTask: jest.fn(),
      deleteRemoteTask: jest.fn(),
    });

    expect(conflict).toMatchObject({
      title: 'New server value',
      revision: 8,
      syncState: TASK_SYNC_STATE.conflict,
      syncError: 'conflict',
      pendingIntent: {
        type: 'update',
        baseRevision: 7,
        payload: { title: 'My offline edit', description: 'local intent' },
      },
    });
    expect(isTaskVisible(conflict)).toBe(true);
    expect(hasPendingTasks([conflict])).toBe(true);

    expect(resolveTaskConflict(conflict, 'remote')).toMatchObject({
      title: 'New server value',
      revision: 8,
      syncState: TASK_SYNC_STATE.synced,
    });
    expect(resolveTaskConflict(conflict, 'local')).toMatchObject({
      title: 'My offline edit',
      revision: 8,
      syncState: TASK_SYNC_STATE.pendingUpdate,
    });

    const updateRemoteTask = jest.fn();
    const [rolledConflict] = await reconcilePendingTasks({
      cachedTasks: [conflict],
      remoteTasks: [{ ...freshRemote, title: 'Even newer server value', revision: 9 }],
      updateRemoteTask,
      createRemoteTask: jest.fn(),
      deleteRemoteTask: jest.fn(),
    });
    expect(rolledConflict).toMatchObject({
      title: 'Even newer server value',
      revision: 9,
      syncState: TASK_SYNC_STATE.conflict,
      pendingIntent: {
        type: 'update',
        payload: { title: 'My offline edit' },
      },
    });
    expect(updateRemoteTask).not.toHaveBeenCalled();
  });

  it('keeps a fresh remote task visible when a revision-safe delete conflicts', async () => {
    const remoteId = '507f1f77bcf86cd799439082';
    const cached = normalizeStoredTask({
      id: remoteId,
      title: 'Delete my old copy',
      revision: 2,
      syncState: TASK_SYNC_STATE.pendingDelete,
    });
    const freshRemote = normalizeStoredTask({
      id: remoteId,
      title: 'Server edited this task',
      description: 'must be reviewed',
      revision: 3,
    });

    const [conflict] = await reconcilePendingTasks({
      cachedTasks: [cached],
      remoteTasks: [freshRemote],
      deleteRemoteTask: jest.fn().mockRejectedValue({ response: { status: 412 } }),
      createRemoteTask: jest.fn(),
      updateRemoteTask: jest.fn(),
    });

    expect(conflict).toMatchObject({
      title: 'Server edited this task',
      revision: 3,
      syncState: TASK_SYNC_STATE.conflict,
      pendingIntent: { type: 'delete', baseRevision: 2 },
    });
    expect(isTaskVisible(conflict)).toBe(true);
    expect(resolveTaskConflict(conflict, 'local')).toMatchObject({
      title: 'Server edited this task',
      revision: 3,
      syncState: TASK_SYNC_STATE.pendingDelete,
    });
  });

  it('handles no-op, remote-missing and invalid conflict resolutions safely', () => {
    expect(resolveTaskConflict(null, 'remote')).toBeNull();

    const missing = normalizeStoredTask({
      id: '507f1f77bcf86cd799439083',
      title: 'Gone remotely',
      revision: 4,
      syncState: TASK_SYNC_STATE.conflict,
      syncError: 'conflict',
      remoteMissing: true,
      pendingIntent: { type: 'delete', baseRevision: 3 },
    });
    expect(resolveTaskConflict(missing, 'remote')).toBeNull();
    expect(resolveTaskConflict(missing, 'unsupported')).toEqual(missing);
  });
});
