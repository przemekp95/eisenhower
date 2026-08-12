import {
  TASK_SYNC_STATE,
  createClientOperationId,
  createPendingTask,
  getTaskRemoteId,
  hasPendingTasks,
  isRemoteTaskId,
  isTaskPendingSync,
  isTaskVisible,
  markTaskPendingDelete,
  markTaskPendingDelegation,
  markTaskPendingDelegationStatus,
  markTaskPendingLifecycle,
  markTaskPendingSchedule,
  markTaskSyncFailed,
  markTaskPendingUpdate,
  reconcilePendingTasks,
  normalizeStoredTask,
  normalizeStoredTasks,
  removeTask,
  resolveTaskConflict,
  runSingleFlight,
  taskToRemotePayload,
  upsertTask,
} from './taskSync';

describe('task lifecycle synchronization', () => {
  const remoteId = '507f1f77bcf86cd799439011';

  it('normalizes legacy and explicit lifecycle snapshots for offline storage', () => {
    expect(normalizeStoredTask({ id: 'local', title: 'Legacy' })).toMatchObject({
      lifecycleState: 'active',
    });
    expect(normalizeStoredTask({
      id: remoteId,
      title: 'Trashed',
      lifecycleState: 'trashed',
      priorLifecycleState: 'completed',
    })).toMatchObject({
      lifecycleState: 'trashed',
      priorLifecycleState: 'completed',
    });
  });

  it('records an offline lifecycle intent and restores its prior trash state', () => {
    const completed = normalizeStoredTask({
      id: remoteId,
      title: 'Done',
      revision: 2,
      lifecycleState: 'completed',
    });
    const trashed = markTaskPendingLifecycle(completed, 'trash');

    expect(trashed).toMatchObject({
      lifecycleState: 'trashed',
      priorLifecycleState: 'completed',
      syncState: TASK_SYNC_STATE.pendingLifecycle,
      pendingIntent: { type: 'lifecycle', action: 'trash', baseRevision: 2 },
    });
    expect(markTaskPendingLifecycle(trashed, 'restore')).toMatchObject({
      lifecycleState: 'completed',
    });
    expect(markTaskPendingLifecycle(completed, 'archive')).toMatchObject({
      lifecycleState: 'archived',
    });
    expect(markTaskPendingLifecycle(completed, 'complete')).toBeNull();
  });

  it('applies a successful pending lifecycle transition during reconciliation', async () => {
    const pending = markTaskPendingLifecycle(normalizeStoredTask({
      id: remoteId,
      title: 'Active',
      revision: 3,
      lifecycleState: 'active',
    }), 'complete');
    const transitioned = normalizeStoredTask({
      id: remoteId,
      title: 'Active',
      revision: 4,
      lifecycleState: 'completed',
    });
    const transitionRemoteTaskLifecycle = jest.fn().mockResolvedValue(transitioned);

    await expect(reconcilePendingTasks({
      cachedTasks: [pending],
      remoteTasks: [],
      createRemoteTask: jest.fn(),
      updateRemoteTask: jest.fn(),
      transitionRemoteTaskLifecycle,
      deleteRemoteTask: jest.fn(),
    })).resolves.toEqual([transitioned]);
  });

  it('replays lifecycle intents and keeps the intent in conflict snapshots', async () => {
    const pending = markTaskPendingLifecycle(normalizeStoredTask({
      id: remoteId,
      title: 'Active',
      revision: 3,
      lifecycleState: 'active',
    }), 'complete');
    const transitionRemoteTaskLifecycle = jest.fn().mockRejectedValue({ status: 412 });

    const [conflict] = await reconcilePendingTasks({
      cachedTasks: [pending],
      remoteTasks: [normalizeStoredTask({
        id: remoteId,
        title: 'Changed remotely',
        revision: 4,
        lifecycleState: 'active',
      })],
      createRemoteTask: jest.fn(),
      updateRemoteTask: jest.fn(),
      transitionRemoteTaskLifecycle,
      deleteRemoteTask: jest.fn(),
    });

    expect(transitionRemoteTaskLifecycle).toHaveBeenCalledWith(remoteId, 'complete', 'pl', 3);
    expect(conflict).toMatchObject({
      title: 'Changed remotely',
      syncState: TASK_SYNC_STATE.conflict,
      pendingIntent: {
        type: 'lifecycle',
        action: 'complete',
        localLifecycleState: 'completed',
      },
    });
    expect(resolveTaskConflict(conflict, 'local')).toMatchObject({
      lifecycleState: 'completed',
      syncState: TASK_SYNC_STATE.pendingLifecycle,
    });
  });

  it('permits pending final purge only for trashed tasks', () => {
    const active = normalizeStoredTask({ id: remoteId, title: 'Active', lifecycleState: 'active' });
    const trashed = normalizeStoredTask({ id: remoteId, title: 'Trash', lifecycleState: 'trashed' });

    expect(markTaskPendingDelete(active)).toBeNull();
    expect(markTaskPendingDelete(trashed)).toMatchObject({
      syncState: TASK_SYNC_STATE.pendingDelete,
      lifecycleState: 'trashed',
    });
  });
});

describe('task schedule synchronization', () => {
  const remoteId = '507f1f77bcf86cd799439011';
  const schedule = {
    dueAt: '2026-08-15T12:00:00.000Z',
    timeZone: 'Europe/Warsaw',
    remindAt: '2026-08-15T10:00:00.000Z',
  };

  it('persists an explicit revision-safe schedule intent', () => {
    const pending = markTaskPendingSchedule(normalizeStoredTask({
      id: remoteId,
      title: 'Scheduled',
      revision: 4,
    }), schedule);
    expect(pending).toMatchObject({
      schedule,
      syncState: TASK_SYNC_STATE.pendingSchedule,
      pendingIntent: { type: 'schedule', schedule, baseRevision: 4 },
    });
  });

  it('preserves the native reminder id while reconciling an unchanged remote task', async () => {
    const cached = normalizeStoredTask({
      id: remoteId,
      title: 'Scheduled',
      notificationId: 'native-existing',
      reminderStatus: 'scheduled',
    });
    const remote = normalizeStoredTask({ id: remoteId, title: 'Scheduled', revision: 1 });
    await expect(reconcilePendingTasks({
      cachedTasks: [cached],
      remoteTasks: [remote],
      createRemoteTask: jest.fn(),
      updateRemoteTask: jest.fn(),
      updateRemoteTaskSchedule: jest.fn(),
      transitionRemoteTaskLifecycle: jest.fn(),
      deleteRemoteTask: jest.fn(),
    })).resolves.toEqual([expect.objectContaining({
      notificationId: 'native-existing',
      reminderStatus: 'scheduled',
    })]);

    const statusOnlyId = '507f1f77bcf86cd799439012';
    await expect(reconcilePendingTasks({
      cachedTasks: [normalizeStoredTask({
        id: statusOnlyId,
        title: 'Permission denied',
        reminderStatus: 'permission_denied',
      })],
      remoteTasks: [normalizeStoredTask({ id: statusOnlyId, title: 'Permission denied' })],
      createRemoteTask: jest.fn(),
      updateRemoteTask: jest.fn(),
      updateRemoteTaskSchedule: jest.fn(),
      transitionRemoteTaskLifecycle: jest.fn(),
      deleteRemoteTask: jest.fn(),
    })).resolves.toEqual([expect.objectContaining({
      reminderStatus: 'permission_denied',
    })]);
  });

  it('replays a pending schedule through its dedicated endpoint', async () => {
    const pending = markTaskPendingSchedule(normalizeStoredTask({ id: remoteId, title: 'Task', revision: 4 }), schedule);
    const remote = normalizeStoredTask({ id: remoteId, title: 'Task', revision: 5, schedule });
    const updateRemoteTaskSchedule = jest.fn().mockResolvedValue(remote);
    await expect(reconcilePendingTasks({
      cachedTasks: [pending],
      remoteTasks: [],
      createRemoteTask: jest.fn(),
      updateRemoteTask: jest.fn(),
      updateRemoteTaskSchedule,
      transitionRemoteTaskLifecycle: jest.fn(),
      deleteRemoteTask: jest.fn(),
    })).resolves.toEqual([remote]);
    expect(updateRemoteTaskSchedule).toHaveBeenCalledWith(remoteId, schedule, 'pl', 4);
  });

  it('creates an offline task first and then applies its persisted schedule intent', async () => {
    const local = markTaskPendingSchedule(normalizeStoredTask({
      id: 'local-scheduled',
      title: 'Offline scheduled',
      syncState: TASK_SYNC_STATE.pendingCreate,
      clientOperationId: 'mobile-scheduled',
    }), schedule);
    const created = normalizeStoredTask({ id: remoteId, title: 'Offline scheduled', revision: 0 });
    const scheduled = normalizeStoredTask({ id: remoteId, title: 'Offline scheduled', revision: 1, schedule });
    const updateRemoteTaskSchedule = jest.fn().mockResolvedValue(scheduled);

    await expect(reconcilePendingTasks({
      cachedTasks: [local],
      remoteTasks: [],
      createRemoteTask: jest.fn().mockResolvedValue(created),
      updateRemoteTaskSchedule,
      updateRemoteTask: jest.fn(),
      transitionRemoteTaskLifecycle: jest.fn(),
      deleteRemoteTask: jest.fn(),
    })).resolves.toEqual([scheduled]);
    expect(updateRemoteTaskSchedule).toHaveBeenCalledWith(remoteId, schedule, 'pl', 0);
  });

  it('keeps a schedule intent for explicit conflict resolution', async () => {
    const pending = markTaskPendingSchedule(normalizeStoredTask({ id: remoteId, title: 'Task', revision: 4 }), schedule);
    const fresh = normalizeStoredTask({ id: remoteId, title: 'Server task', revision: 5 });
    const [conflict] = await reconcilePendingTasks({
      cachedTasks: [pending],
      remoteTasks: [fresh],
      createRemoteTask: jest.fn(),
      updateRemoteTask: jest.fn(),
      updateRemoteTaskSchedule: jest.fn().mockRejectedValue({ status: 412 }),
      transitionRemoteTaskLifecycle: jest.fn(),
      deleteRemoteTask: jest.fn(),
    });

    expect(conflict).toMatchObject({
      title: 'Server task',
      revision: 5,
      syncState: TASK_SYNC_STATE.conflict,
      pendingIntent: { type: 'schedule', schedule },
    });
    expect(resolveTaskConflict(conflict, 'local')).toMatchObject({
      schedule,
      syncState: TASK_SYNC_STATE.pendingSchedule,
      pendingIntent: { baseRevision: 5 },
    });
  });

  it('keeps the newly created remote identity when the follow-up schedule write fails', async () => {
    const local = markTaskPendingSchedule(normalizeStoredTask({
      id: 'local-scheduled-failure',
      title: 'Offline scheduled',
      syncState: TASK_SYNC_STATE.pendingCreate,
      reminderStatus: 'scheduled',
      notificationId: 'native-id',
    }), schedule);
    const created = normalizeStoredTask({ id: remoteId, title: 'Offline scheduled', revision: 0 });
    const [pending] = await reconcilePendingTasks({
      cachedTasks: [local],
      remoteTasks: [],
      createRemoteTask: jest.fn().mockResolvedValue(created),
      updateRemoteTaskSchedule: jest.fn().mockRejectedValue(new Error('offline')),
      updateRemoteTask: jest.fn(),
      transitionRemoteTaskLifecycle: jest.fn(),
      deleteRemoteTask: jest.fn(),
    });
    expect(pending).toMatchObject({
      id: remoteId,
      remoteId,
      syncState: TASK_SYNC_STATE.pendingSchedule,
      syncError: 'error',
      schedule,
      notificationId: 'native-id',
      reminderStatus: 'scheduled',
    });
  });
});

describe('task delegation synchronization', () => {
  const remoteId = '507f1f77bcf86cd799439041';
  const assignment = { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: 'Runbook' };

  it('persists owner assignment and assignee transition intents', () => {
    expect(markTaskPendingDelegation(normalizeStoredTask({ id: remoteId, title: 'Owner', revision: 2 }), assignment))
      .toMatchObject({
        syncState: TASK_SYNC_STATE.pendingDelegation,
        delegation: assignment,
        pendingIntent: { type: 'delegation', delegation: assignment, baseRevision: 2 },
      });
    expect(markTaskPendingDelegationStatus(normalizeStoredTask({
      id: remoteId,
      title: 'Assignee',
      revision: 3,
      delegationRole: 'assignee',
      delegation: { ...assignment, status: 'offered' },
    }), 'accepted')).toMatchObject({
      syncState: TASK_SYNC_STATE.pendingDelegationStatus,
      delegation: expect.objectContaining({ status: 'accepted' }),
      pendingIntent: { type: 'delegation_status', status: 'accepted', baseRevision: 3 },
    });
    expect(markTaskPendingDelegationStatus(normalizeStoredTask({
      id: remoteId, title: 'No delegation', revision: 1,
    }), 'accepted')).toBeNull();
    expect(markTaskPendingDelegation(normalizeStoredTask({
      id: remoteId, title: 'Cancel delegation', revision: 4,
      delegation: { ...assignment, status: 'offered' },
    }), null)).toMatchObject({
      syncState: TASK_SYNC_STATE.pendingDelegation,
      pendingIntent: { type: 'delegation', delegation: null, baseRevision: 4 },
    });
  });

  it('replays owner and assignee intents and creates conflict snapshots', async () => {
    const ownerPending = markTaskPendingDelegation(normalizeStoredTask({ id: remoteId, title: 'Owner', revision: 2 }), assignment);
    const updateRemoteTaskDelegation = jest.fn().mockResolvedValue(normalizeStoredTask({
      id: remoteId, title: 'Owner', revision: 3, delegation: { ...assignment, status: 'offered' },
    }));
    await reconcilePendingTasks({
      cachedTasks: [ownerPending], remoteTasks: [],
      createRemoteTask: jest.fn(), updateRemoteTask: jest.fn(), updateRemoteTaskSchedule: jest.fn(),
      updateRemoteTaskDelegation, transitionRemoteTaskDelegation: jest.fn(),
      transitionRemoteTaskLifecycle: jest.fn(), deleteRemoteTask: jest.fn(),
    });
    expect(updateRemoteTaskDelegation).toHaveBeenCalledWith(remoteId, assignment, 'pl', 2);

    const statusPending = markTaskPendingDelegationStatus(normalizeStoredTask({
      id: remoteId, title: 'Assignee', revision: 3, delegationRole: 'assignee',
      delegation: { ...assignment, status: 'offered' },
    }), 'accepted');
    const [conflict] = await reconcilePendingTasks({
      cachedTasks: [statusPending],
      remoteTasks: [normalizeStoredTask({ id: remoteId, title: 'Fresh', revision: 4, delegationRole: 'assignee', delegation: { ...assignment, status: 'offered' } })],
      createRemoteTask: jest.fn(), updateRemoteTask: jest.fn(), updateRemoteTaskSchedule: jest.fn(),
      updateRemoteTaskDelegation: jest.fn(), transitionRemoteTaskDelegation: jest.fn().mockRejectedValue({ status: 412 }),
      transitionRemoteTaskLifecycle: jest.fn(), deleteRemoteTask: jest.fn(),
    });
    expect(conflict).toMatchObject({
      title: 'Fresh', syncState: TASK_SYNC_STATE.conflict,
      pendingIntent: { type: 'delegation_status', status: 'accepted' },
    });
    expect(resolveTaskConflict(conflict, 'local')).toMatchObject({
      syncState: TASK_SYNC_STATE.pendingDelegationStatus,
      delegation: expect.objectContaining({ status: 'accepted' }),
    });
  });

  it('creates an offline owner task before replaying its delegation intent', async () => {
    const local = markTaskPendingDelegation(normalizeStoredTask({
      id: 'local-delegated', title: 'Offline handoff', syncState: TASK_SYNC_STATE.pendingCreate,
    }), assignment);
    const created = normalizeStoredTask({ id: remoteId, title: 'Offline handoff', revision: 0 });
    const offered = normalizeStoredTask({
      id: remoteId, title: 'Offline handoff', revision: 1,
      delegation: { ...assignment, status: 'offered' },
    });
    const updateRemoteTaskDelegation = jest.fn().mockResolvedValue(offered);
    await expect(reconcilePendingTasks({
      cachedTasks: [local], remoteTasks: [],
      createRemoteTask: jest.fn().mockResolvedValue(created),
      updateRemoteTask: jest.fn(), updateRemoteTaskSchedule: jest.fn(),
      updateRemoteTaskDelegation, transitionRemoteTaskDelegation: jest.fn(),
      transitionRemoteTaskLifecycle: jest.fn(), deleteRemoteTask: jest.fn(),
    })).resolves.toEqual([offered]);
    expect(updateRemoteTaskDelegation).toHaveBeenCalledWith(remoteId, assignment, 'pl', 0);
  });

  it('preserves failed create handoffs and resolves owner assignment conflicts explicitly', async () => {
    const local = markTaskPendingDelegation(normalizeStoredTask({
      id: 'local-delegation-failure', title: 'Offline handoff', syncState: TASK_SYNC_STATE.pendingCreate,
    }), assignment);
    const created = normalizeStoredTask({ id: remoteId, title: 'Offline handoff', revision: 0 });
    const [failed] = await reconcilePendingTasks({
      cachedTasks: [local], remoteTasks: [], createRemoteTask: jest.fn().mockResolvedValue(created),
      updateRemoteTask: jest.fn(), updateRemoteTaskSchedule: jest.fn(),
      updateRemoteTaskDelegation: jest.fn().mockRejectedValue(new Error('offline')),
      transitionRemoteTaskDelegation: jest.fn(), transitionRemoteTaskLifecycle: jest.fn(), deleteRemoteTask: jest.fn(),
    });
    expect(failed).toMatchObject({ id: remoteId, syncState: TASK_SYNC_STATE.pendingDelegation, syncError: 'error' });

    const pending = markTaskPendingDelegation(normalizeStoredTask({ id: remoteId, title: 'Mine', revision: 2 }), assignment);
    const [conflict] = await reconcilePendingTasks({
      cachedTasks: [pending],
      remoteTasks: [normalizeStoredTask({ id: remoteId, title: 'Fresh', revision: 3 })],
      createRemoteTask: jest.fn(), updateRemoteTask: jest.fn(), updateRemoteTaskSchedule: jest.fn(),
      updateRemoteTaskDelegation: jest.fn().mockRejectedValue({ status: 412 }),
      transitionRemoteTaskDelegation: jest.fn(), transitionRemoteTaskLifecycle: jest.fn(), deleteRemoteTask: jest.fn(),
    });
    expect(resolveTaskConflict(conflict, 'local')).toMatchObject({
      title: 'Fresh', syncState: TASK_SYNC_STATE.pendingDelegation,
      delegation: expect.objectContaining(assignment), pendingIntent: { baseRevision: 3 },
    });

    const transportPending = markTaskPendingDelegation(normalizeStoredTask({
      id: remoteId, title: 'Transport pending', revision: 4,
    }), assignment);
    await expect(reconcilePendingTasks({
      cachedTasks: [transportPending], remoteTasks: [], createRemoteTask: jest.fn(),
      updateRemoteTask: jest.fn(), updateRemoteTaskSchedule: jest.fn(),
      updateRemoteTaskDelegation: jest.fn().mockRejectedValue(new Error('offline')),
      transitionRemoteTaskDelegation: jest.fn(), transitionRemoteTaskLifecycle: jest.fn(), deleteRemoteTask: jest.fn(),
    })).resolves.toEqual([expect.objectContaining({
      syncState: TASK_SYNC_STATE.pendingDelegation, syncError: 'error',
    })]);

    const cancelPending = markTaskPendingDelegation(normalizeStoredTask({
      id: remoteId, title: 'Cancel pending', revision: 5,
      delegation: { ...assignment, status: 'offered' },
    }), null);
    const cancelled = normalizeStoredTask({ id: remoteId, title: 'Cancel pending', revision: 6 });
    const updateRemoteTaskDelegation = jest.fn().mockResolvedValue(cancelled);
    await expect(reconcilePendingTasks({
      cachedTasks: [cancelPending], remoteTasks: [], createRemoteTask: jest.fn(),
      updateRemoteTask: jest.fn(), updateRemoteTaskSchedule: jest.fn(), updateRemoteTaskDelegation,
      transitionRemoteTaskDelegation: jest.fn(), transitionRemoteTaskLifecycle: jest.fn(), deleteRemoteTask: jest.fn(),
    })).resolves.toEqual([cancelled]);
    expect(updateRemoteTaskDelegation).toHaveBeenCalledWith(remoteId, null, 'pl', 5);

    const cancelConflict = markTaskPendingDelegation(normalizeStoredTask({
      id: remoteId, title: 'Cancel conflict', revision: 6,
      delegation: { ...assignment, status: 'offered' },
    }), null);
    const [conflictCancel] = await reconcilePendingTasks({
      cachedTasks: [cancelConflict],
      remoteTasks: [normalizeStoredTask({
        id: remoteId, title: 'Fresh delegated', revision: 7,
        delegation: { ...assignment, status: 'accepted' },
      })],
      createRemoteTask: jest.fn(), updateRemoteTask: jest.fn(), updateRemoteTaskSchedule: jest.fn(),
      updateRemoteTaskDelegation: jest.fn().mockRejectedValue({ status: 412 }),
      transitionRemoteTaskDelegation: jest.fn(), transitionRemoteTaskLifecycle: jest.fn(), deleteRemoteTask: jest.fn(),
    });
    expect(resolveTaskConflict(conflictCancel, 'local')).toMatchObject({
      title: 'Fresh delegated', syncState: TASK_SYNC_STATE.pendingDelegation,
      pendingIntent: { delegation: null, baseRevision: 7 },
    });
    expect(resolveTaskConflict(conflictCancel, 'local').delegation).toBeUndefined();
  });

  it('applies a successful assignee status replay and keeps transport failures pending', async () => {
    const pending = markTaskPendingDelegationStatus(normalizeStoredTask({
      id: remoteId, title: 'Assignee', revision: 3, delegationRole: 'assignee',
      delegation: { ...assignment, status: 'offered' },
    }), 'accepted');
    const accepted = normalizeStoredTask({
      id: remoteId, title: 'Assignee', revision: 4, delegationRole: 'assignee',
      delegation: { ...assignment, status: 'accepted' },
    });
    const base = {
      cachedTasks: [pending], remoteTasks: [], createRemoteTask: jest.fn(), updateRemoteTask: jest.fn(),
      updateRemoteTaskSchedule: jest.fn(), updateRemoteTaskDelegation: jest.fn(),
      transitionRemoteTaskLifecycle: jest.fn(), deleteRemoteTask: jest.fn(),
    };
    await expect(reconcilePendingTasks({
      ...base, transitionRemoteTaskDelegation: jest.fn().mockResolvedValue(accepted),
    })).resolves.toEqual([accepted]);
    await expect(reconcilePendingTasks({
      ...base, transitionRemoteTaskDelegation: jest.fn().mockRejectedValue(new Error('offline')),
    })).resolves.toEqual([expect.objectContaining({
      syncState: TASK_SYNC_STATE.pendingDelegationStatus, syncError: 'error',
    })]);
  });
});

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
      revision: 0,
      lifecycleState: 'active',
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
      clientOperationId: 'mobile-local-1',
      lifecycleState: 'active',
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
      clientOperationId: 'mobile-local-1',
      lifecycleState: 'active',
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
      clientOperationId: 'mobile-local-1',
      lifecycleState: 'active',
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
        lifecycleState: 'trashed',
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
      lifecycleState: 'trashed',
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
          lifecycleState: 'trashed',
        }),
      ],
      language: 'pl',
      createRemoteTask,
      updateRemoteTask,
      deleteRemoteTask,
    });

    expect(createRemoteTask).toHaveBeenCalledWith(
      { title: 'Offline', description: 'draft', urgent: false, important: true },
      'pl',
      'mobile-local-1'
    );
    expect(updateRemoteTask).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439012',
      { title: 'Update me', description: 'refresh', urgent: true, important: false },
      'pl',
      0
    );
    expect(deleteRemoteTask).toHaveBeenCalledWith('507f1f77bcf86cd799439013', 0, 'trashed');
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
      lifecycleState: 'trashed',
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
      lifecycleState: 'trashed',
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
    expect(deleteRemoteTask).toHaveBeenCalledWith(remoteId, 8, 'trashed');
    expect(resolved).toEqual([
      expect.objectContaining({
        title: 'Revision update',
        revision: 8,
        syncState: TASK_SYNC_STATE.conflict,
        syncError: 'conflict',
        pendingIntent: { type: 'delete', baseRevision: 8, localLifecycleState: 'trashed' },
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
      lifecycleState: 'trashed',
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
      pendingIntent: { type: 'delete', baseRevision: 2, localLifecycleState: 'trashed' },
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

  it('preserves one stable client operation id across normalization and retries', async () => {
    const pending = createPendingTask(
      'pl',
      { title: 'Stable retry', clientOperationId: 'mobile-explicit-operation' },
      'local-stable'
    );
    const reloaded = normalizeStoredTask(JSON.parse(JSON.stringify(pending)));
    const createRemoteTask = jest.fn().mockRejectedValue(new Error('response lost'));

    await reconcilePendingTasks({
      cachedTasks: [reloaded],
      remoteTasks: [],
      createRemoteTask,
      updateRemoteTask: jest.fn(),
      deleteRemoteTask: jest.fn(),
    });
    await reconcilePendingTasks({
      cachedTasks: [reloaded],
      remoteTasks: [],
      createRemoteTask,
      updateRemoteTask: jest.fn(),
      deleteRemoteTask: jest.fn(),
    });

    expect(reloaded.clientOperationId).toBe('mobile-explicit-operation');
    expect(createRemoteTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ title: 'Stable retry' }),
      'pl',
      'mobile-explicit-operation'
    );
    expect(createRemoteTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: 'Stable retry' }),
      'pl',
      'mobile-explicit-operation'
    );
  });

  it('coalesces concurrent sync triggers into one in-flight operation', async () => {
    const inFlightRef = { current: null };
    let release;
    const operation = jest.fn(() => new Promise((resolve) => {
      release = resolve;
    }));

    const first = runSingleFlight(inFlightRef, operation);
    const second = runSingleFlight(inFlightRef, operation);
    const third = runSingleFlight(inFlightRef, operation);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(operation).toHaveBeenCalledTimes(1);
    release(true);
    await expect(first).resolves.toBe(true);
    await expect(runSingleFlight(inFlightRef, async () => false)).resolves.toBe(false);
  });

  it('converts synchronous sync failures to a rejected promise and clears the flight', async () => {
    const inFlightRef = { current: null };

    await expect(runSingleFlight(inFlightRef, () => {
      throw new Error('sync failed synchronously');
    })).rejects.toThrow('sync failed synchronously');
    expect(inFlightRef.current).toBeNull();
  });

  it('creates a non-empty operation id without a native UUID implementation', () => {
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    try {
      expect(createClientOperationId()).toMatch(/^mobile-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
    } finally {
      if (originalCrypto) {
        Object.defineProperty(globalThis, 'crypto', originalCrypto);
      } else {
        delete globalThis.crypto;
      }
    }
  });
});
