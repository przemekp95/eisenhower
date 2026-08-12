import { delegationStatusActions, normalizeTaskDelegation } from './taskDelegation';

export const TASK_SYNC_STATE = {
  synced: 'synced',
  pendingCreate: 'pending_create',
  pendingUpdate: 'pending_update',
  pendingLifecycle: 'pending_lifecycle',
  pendingSchedule: 'pending_schedule',
  pendingDelegation: 'pending_delegation',
  pendingDelegationStatus: 'pending_delegation_status',
  pendingDelete: 'pending_delete',
  conflict: 'conflict',
  localSeed: 'local_seed',
};

export function isRemoteTaskId(value) {
  return /^[a-f0-9]{24}$/i.test(String(value || ''));
}

export function getTaskRemoteId(task) {
  if (!task || typeof task !== 'object') {
    return null;
  }

  if (typeof task.remoteId === 'string' && task.remoteId.trim()) {
    return task.remoteId.trim();
  }

  return isRemoteTaskId(task.id) ? String(task.id) : null;
}

export function isTaskPendingSync(task) {
  return [
    TASK_SYNC_STATE.pendingCreate,
    TASK_SYNC_STATE.pendingUpdate,
    TASK_SYNC_STATE.pendingLifecycle,
    TASK_SYNC_STATE.pendingSchedule,
    TASK_SYNC_STATE.pendingDelegation,
    TASK_SYNC_STATE.pendingDelegationStatus,
    TASK_SYNC_STATE.pendingDelete,
  ].includes(task?.syncState);
}

export function isTaskVisible(task) {
  return task?.syncState !== TASK_SYNC_STATE.pendingDelete;
}

export function normalizeStoredTask(task, language = 'pl') {
  const id = String(task?.id ?? task?._id ?? '');
  const remoteId = getTaskRemoteId({ ...task, id });
  let syncState =
    typeof task?.syncState === 'string' ? task.syncState : null;

  if (!syncState) {
    if (remoteId) {
      syncState = TASK_SYNC_STATE.synced;
    } else if (id.startsWith('seed-')) {
      syncState = TASK_SYNC_STATE.localSeed;
    } else {
      syncState = TASK_SYNC_STATE.pendingCreate;
    }
  }

  if (syncState === TASK_SYNC_STATE.synced && !remoteId) {
    syncState = id.startsWith('seed-')
      ? TASK_SYNC_STATE.localSeed
      : TASK_SYNC_STATE.pendingCreate;
  }

  if (
    !remoteId &&
    (syncState === TASK_SYNC_STATE.pendingUpdate ||
      syncState === TASK_SYNC_STATE.pendingLifecycle ||
      syncState === TASK_SYNC_STATE.pendingSchedule ||
      syncState === TASK_SYNC_STATE.pendingDelegation ||
      syncState === TASK_SYNC_STATE.pendingDelegationStatus ||
      syncState === TASK_SYNC_STATE.pendingDelete)
  ) {
    syncState = id.startsWith('seed-')
      ? TASK_SYNC_STATE.localSeed
      : TASK_SYNC_STATE.pendingCreate;
  }

  const clientOperationId = syncState === TASK_SYNC_STATE.pendingCreate
    ? (
      typeof task?.clientOperationId === 'string' && task.clientOperationId.trim()
        ? task.clientOperationId.trim()
        : `mobile-${id.replace(/[^A-Za-z0-9._:-]/g, '_')}`.slice(0, 128)
    )
    : null;

  return {
    id,
    title: String(task?.title || '').trim(),
    description: String(task?.description || '').trim(),
    urgent: Boolean(task?.urgent),
    important: Boolean(task?.important),
    locale: task?.locale || language,
    remoteId,
    syncState,
    lifecycleState: ['active', 'completed', 'archived', 'trashed'].includes(task?.lifecycleState)
      ? task.lifecycleState
      : 'active',
    ...(['active', 'completed', 'archived'].includes(task?.priorLifecycleState)
      ? { priorLifecycleState: task.priorLifecycleState }
      : {}),
    ...(clientOperationId ? { clientOperationId } : {}),
    ...(Number.isInteger(task?.revision)
      ? { revision: task.revision }
      : remoteId
        ? { revision: 0 }
        : {}),
    ...(task?.syncError === 'conflict' || task?.syncError === 'error'
      ? { syncError: task.syncError }
      : {}),
    ...(task?.pendingIntent && typeof task.pendingIntent === 'object'
      ? { pendingIntent: task.pendingIntent }
      : {}),
    ...(task?.schedule && typeof task.schedule === 'object'
      ? { schedule: task.schedule }
      : {}),
    ...(typeof task?.notificationId === 'string' && task.notificationId
      ? { notificationId: task.notificationId }
      : {}),
    ...(typeof task?.reminderStatus === 'string'
      ? { reminderStatus: task.reminderStatus }
      : {}),
    ...(normalizeTaskDelegation(task?.delegation)
      ? { delegation: normalizeTaskDelegation(task.delegation) }
      : {}),
    ...(task?.delegationRole === 'assignee' ? { delegationRole: 'assignee' } : {}),
    ...(task?.remoteMissing === true ? { remoteMissing: true } : {}),
  };
}

export function normalizeStoredTasks(tasks, language = 'pl') {
  if (!Array.isArray(tasks)) {
    return [];
  }

  return tasks.map((task) => normalizeStoredTask(task, language));
}

export function createPendingTask(language, task, id) {
  return normalizeStoredTask(
    {
      id,
      title: task.title,
      description: task.description,
      urgent: task.urgent,
      important: task.important,
      locale: language,
      remoteId: null,
      syncState: TASK_SYNC_STATE.pendingCreate,
      clientOperationId: task.clientOperationId,
      lifecycleState: 'active',
    },
    language
  );
}

export function createClientOperationId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `mobile-${uuid}`;
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function runSingleFlight(inFlightRef, operation) {
  if (inFlightRef.current) {
    return inFlightRef.current;
  }
  let operationResult;
  try {
    operationResult = operation();
  } catch (error) {
    operationResult = Promise.reject(error);
  }
  const promise = Promise.resolve(operationResult);
  const trackedPromise = promise.finally(() => {
      if (inFlightRef.current === trackedPromise) {
        inFlightRef.current = null;
      }
    });
  inFlightRef.current = trackedPromise;
  return trackedPromise;
}

export function markTaskPendingUpdate(task, patch = {}) {
  const nextSyncState =
    task.syncState === TASK_SYNC_STATE.pendingCreate ||
    task.syncState === TASK_SYNC_STATE.localSeed
      ? task.syncState
      : TASK_SYNC_STATE.pendingUpdate;

  return normalizeStoredTask(
    {
      ...task,
      ...patch,
      syncState: nextSyncState,
      syncError: undefined,
      pendingIntent: undefined,
    },
    task.locale
  );
}

export function markTaskPendingDelete(task) {
  if (!getTaskRemoteId(task) || task.lifecycleState !== 'trashed') {
    return null;
  }

  return normalizeStoredTask(
    {
      ...task,
      syncState: TASK_SYNC_STATE.pendingDelete,
      syncError: undefined,
      pendingIntent: undefined,
    },
    task.locale
  );
}

function resolveLocalLifecycle(task, action) {
  const current = task.lifecycleState || 'active';
  if (action === 'complete' && current === 'active') return { lifecycleState: 'completed' };
  if (action === 'reopen' && current === 'completed') return { lifecycleState: 'active' };
  if (action === 'archive' && (current === 'active' || current === 'completed')) {
    return { lifecycleState: 'archived' };
  }
  if (action === 'trash' && current !== 'trashed') {
    return { lifecycleState: 'trashed', priorLifecycleState: current };
  }
  if (action === 'restore' && current === 'archived') return { lifecycleState: 'active' };
  if (action === 'restore' && current === 'trashed') {
    return { lifecycleState: task.priorLifecycleState || 'active' };
  }
  return null;
}

export function markTaskPendingLifecycle(task, action) {
  const transition = resolveLocalLifecycle(task, action);
  if (!transition) return null;
  const { priorLifecycleState: _priorLifecycleState, ...withoutPrior } = task;
  const nextTask = {
    ...withoutPrior,
    ...transition,
    syncState: getTaskRemoteId(task)
      ? TASK_SYNC_STATE.pendingLifecycle
      : task.syncState,
    syncError: undefined,
    pendingIntent: {
      type: 'lifecycle',
      action,
      baseRevision: task.revision,
    },
  };
  return normalizeStoredTask(nextTask, task.locale);
}

export function markTaskPendingSchedule(task, schedule) {
  const remoteId = getTaskRemoteId(task);
  return normalizeStoredTask({
    ...task,
    ...(schedule ? { schedule } : { schedule: undefined }),
    syncState: remoteId ? TASK_SYNC_STATE.pendingSchedule : task.syncState,
    syncError: undefined,
    pendingIntent: {
      type: 'schedule',
      schedule,
      baseRevision: task.revision,
    },
  }, task.locale);
}

export function markTaskPendingDelegation(task, delegation) {
  return normalizeStoredTask({
    ...task,
    ...(delegation
      ? { delegation: { ...delegation, status: 'offered' } }
      : { delegation: undefined }),
    syncState: getTaskRemoteId(task) ? TASK_SYNC_STATE.pendingDelegation : task.syncState,
    syncError: undefined,
    pendingIntent: {
      type: 'delegation',
      delegation,
      baseRevision: task.revision,
    },
  }, task.locale);
}

export function markTaskPendingDelegationStatus(task, status) {
  if (!task.delegation || !delegationStatusActions(task.delegation.status).includes(status)) {
    return null;
  }
  return normalizeStoredTask({
    ...task,
    delegation: { ...task.delegation, status },
    syncState: TASK_SYNC_STATE.pendingDelegationStatus,
    syncError: undefined,
    pendingIntent: {
      type: 'delegation_status',
      status,
      baseRevision: task.revision,
    },
  }, task.locale);
}

export function markTaskSyncFailed(task, error) {
  const status = Number(error?.status || error?.response?.status || 0);
  return {
    ...task,
    syncError: status === 409 || status === 412 ? 'conflict' : 'error',
  };
}

function isRevisionConflict(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  return status === 409 || status === 412;
}

function createConflictTask(resolvedTasks, localTask, type) {
  const remoteId = getTaskRemoteId(localTask);
  const freshRemote = resolvedTasks.find((task) => getTaskRemoteId(task) === remoteId);
  const visibleTask = freshRemote || localTask;

  const lifecycleIntent = type === 'lifecycle'
    ? {
      ...localTask.pendingIntent,
      type: 'lifecycle',
      localLifecycleState: localTask.lifecycleState,
      ...(localTask.priorLifecycleState
        ? { priorLifecycleState: localTask.priorLifecycleState }
        : {}),
    }
    : null;

  const scheduleIntent = type === 'schedule'
    ? { ...localTask.pendingIntent, type: 'schedule', schedule: localTask.schedule || null }
    : null;
  const delegationIntent = type === 'delegation'
    ? { ...localTask.pendingIntent, type: 'delegation', delegation: localTask.pendingIntent?.delegation ?? null }
    : null;
  const delegationStatusIntent = type === 'delegation_status'
    ? { ...localTask.pendingIntent, type: 'delegation_status', status: localTask.pendingIntent?.status }
    : null;

  return {
    ...visibleTask,
    syncState: TASK_SYNC_STATE.conflict,
    syncError: 'conflict',
    pendingIntent: lifecycleIntent || scheduleIntent || delegationIntent || delegationStatusIntent || {
        type,
        baseRevision: localTask.revision,
        ...(type === 'update' ? { payload: taskToRemotePayload(localTask) } : {}),
        ...(type === 'delete'
          ? { localLifecycleState: localTask.lifecycleState }
          : {}),
      },
  };
}

export function resolveTaskConflict(task, resolution) {
  if (task?.syncState !== TASK_SYNC_STATE.conflict || !task.pendingIntent) {
    return task;
  }

  const { pendingIntent: intent, syncError: _syncError, ...freshRemote } = task;

  if (resolution === 'remote') {
    if (task.remoteMissing) {
      return null;
    }
    return { ...freshRemote, syncState: TASK_SYNC_STATE.synced };
  }

  if (resolution === 'local' && intent.type === 'update') {
    return {
      ...freshRemote,
      ...intent.payload,
      syncState: TASK_SYNC_STATE.pendingUpdate,
    };
  }

  if (resolution === 'local' && intent.type === 'delete') {
    return normalizeStoredTask({
      ...freshRemote,
      lifecycleState: intent.localLifecycleState,
      syncState: TASK_SYNC_STATE.pendingDelete,
    }, task.locale);
  }

  if (resolution === 'local' && intent.type === 'lifecycle') {
    return normalizeStoredTask({
      ...freshRemote,
      lifecycleState: intent.localLifecycleState,
      ...(intent.priorLifecycleState
        ? { priorLifecycleState: intent.priorLifecycleState }
        : {}),
      syncState: TASK_SYNC_STATE.pendingLifecycle,
      pendingIntent: {
        ...intent,
        baseRevision: freshRemote.revision,
      },
    }, task.locale);
  }

  if (resolution === 'local' && intent.type === 'schedule') {
    return normalizeStoredTask({
      ...freshRemote,
      ...(intent.schedule ? { schedule: intent.schedule } : { schedule: undefined }),
      syncState: TASK_SYNC_STATE.pendingSchedule,
      pendingIntent: { ...intent, baseRevision: freshRemote.revision },
    }, task.locale);
  }

  if (resolution === 'local' && intent.type === 'delegation') {
    return normalizeStoredTask({
      ...freshRemote,
      ...(intent.delegation
        ? { delegation: { ...intent.delegation, status: 'offered' } }
        : { delegation: undefined }),
      syncState: TASK_SYNC_STATE.pendingDelegation,
      pendingIntent: { ...intent, baseRevision: freshRemote.revision },
    }, task.locale);
  }

  if (resolution === 'local' && intent.type === 'delegation_status') {
    return normalizeStoredTask({
      ...freshRemote,
      delegation: { ...freshRemote.delegation, status: intent.status },
      delegationRole: 'assignee',
      syncState: TASK_SYNC_STATE.pendingDelegationStatus,
      pendingIntent: { ...intent, baseRevision: freshRemote.revision },
    }, task.locale);
  }

  return task;
}

export function taskToRemotePayload(task) {
  return {
    title: String(task.title || '').trim(),
    description: String(task.description || '').trim(),
    urgent: Boolean(task.urgent),
    important: Boolean(task.important),
  };
}

function matchesTaskIdentity(task, candidateId, candidateRemoteId) {
  const taskRemoteId = getTaskRemoteId(task);

  if (candidateRemoteId && taskRemoteId === candidateRemoteId) {
    return true;
  }

  return task.id === candidateId;
}

export function upsertTask(tasks, nextTask) {
  const candidateId = nextTask.id;
  const candidateRemoteId = getTaskRemoteId(nextTask);
  const withoutExisting = tasks.filter(
    (task) => !matchesTaskIdentity(task, candidateId, candidateRemoteId)
  );

  return [nextTask, ...withoutExisting];
}

export function removeTask(tasks, taskOrId) {
  const candidateId =
    typeof taskOrId === 'string' ? String(taskOrId) : String(taskOrId?.id || '');
  const candidateRemoteId =
    typeof taskOrId === 'string' && isRemoteTaskId(taskOrId)
      ? String(taskOrId)
      : getTaskRemoteId(taskOrId);

  return tasks.filter(
    (task) => !matchesTaskIdentity(task, candidateId, candidateRemoteId)
  );
}

export async function reconcilePendingTasks({
  cachedTasks,
  remoteTasks,
  language = 'pl',
  createRemoteTask,
  updateRemoteTask,
  updateRemoteTaskSchedule,
  updateRemoteTaskDelegation,
  transitionRemoteTaskDelegation,
  transitionRemoteTaskLifecycle,
  deleteRemoteTask,
}) {
  let resolvedTasks = normalizeStoredTasks(remoteTasks, language);
  const normalizedCachedTasks = normalizeStoredTasks(cachedTasks, language);

  for (const cachedTask of normalizedCachedTasks) {
    const remoteId = getTaskRemoteId(cachedTask);
    const freshRemote = resolvedTasks.find((task) => getTaskRemoteId(task) === remoteId);
    if (freshRemote && (cachedTask.notificationId || cachedTask.reminderStatus)) {
      resolvedTasks = upsertTask(resolvedTasks, normalizeStoredTask({
        ...freshRemote,
        ...(cachedTask.notificationId ? { notificationId: cachedTask.notificationId } : {}),
        ...(cachedTask.reminderStatus ? { reminderStatus: cachedTask.reminderStatus } : {}),
      }, language));
    }
  }

  for (const conflictTask of normalizedCachedTasks.filter(
    (task) => task.syncState === TASK_SYNC_STATE.conflict
  )) {
    const remoteId = getTaskRemoteId(conflictTask);
    const freshRemote = resolvedTasks.find((task) => getTaskRemoteId(task) === remoteId);
    resolvedTasks = upsertTask(resolvedTasks, {
      ...(freshRemote || conflictTask),
      syncState: TASK_SYNC_STATE.conflict,
      syncError: 'conflict',
      pendingIntent: conflictTask.pendingIntent,
      ...(!freshRemote ? { remoteMissing: true } : {}),
    });
  }

  for (const task of normalizedCachedTasks.filter((item) => isTaskPendingSync(item))) {
    if (task.syncState === TASK_SYNC_STATE.pendingCreate) {
      try {
        let createdTask = await createRemoteTask(
          taskToRemotePayload(task),
          language,
          task.clientOperationId,
        );
        if (task.pendingIntent?.type === 'schedule') {
          try {
            createdTask = await updateRemoteTaskSchedule(
              getTaskRemoteId(createdTask),
              task.pendingIntent.schedule,
              language,
              createdTask.revision,
            );
          } catch (error) {
            createdTask = markTaskSyncFailed(markTaskPendingSchedule({
              ...createdTask,
              ...(task.notificationId ? { notificationId: task.notificationId } : {}),
              ...(task.reminderStatus ? { reminderStatus: task.reminderStatus } : {}),
            }, task.pendingIntent.schedule), error);
          }
        } else if (task.pendingIntent?.type === 'delegation') {
          try {
            createdTask = await updateRemoteTaskDelegation(
              getTaskRemoteId(createdTask),
              task.pendingIntent.delegation,
              language,
              createdTask.revision,
            );
          } catch (error) {
            createdTask = markTaskSyncFailed(markTaskPendingDelegation(
              createdTask,
              task.pendingIntent.delegation,
            ), error);
          }
        }
        createdTask = normalizeStoredTask({
          ...createdTask,
          ...(task.notificationId ? { notificationId: task.notificationId } : {}),
          ...(task.reminderStatus ? { reminderStatus: task.reminderStatus } : {}),
        }, language);
        resolvedTasks = upsertTask(resolvedTasks, createdTask);
      } catch (error) {
        resolvedTasks = upsertTask(resolvedTasks, markTaskSyncFailed(task, error));
      }
      continue;
    }

    if (task.syncState === TASK_SYNC_STATE.pendingUpdate) {
      const remoteId = getTaskRemoteId(task);
      const freshRemote = resolvedTasks.find((candidate) => getTaskRemoteId(candidate) === remoteId);
      const revision = Number.isInteger(task.revision) ? task.revision : freshRemote?.revision;
      try {
        const updatedTask = await updateRemoteTask(
          remoteId,
          taskToRemotePayload(task),
          language,
          revision,
        );
        resolvedTasks = upsertTask(resolvedTasks, updatedTask);
      } catch (error) {
        resolvedTasks = upsertTask(
          resolvedTasks,
          isRevisionConflict(error)
            ? createConflictTask(resolvedTasks, task, 'update')
            : markTaskSyncFailed(task, error)
        );
      }
      continue;
    }


    if (task.syncState === TASK_SYNC_STATE.pendingSchedule) {
      const remoteId = getTaskRemoteId(task);
      const freshRemote = resolvedTasks.find((candidate) => getTaskRemoteId(candidate) === remoteId);
      const revision = Number.isInteger(task.revision) ? task.revision : freshRemote?.revision;
      try {
        const updatedTask = await updateRemoteTaskSchedule(
          remoteId,
          task.pendingIntent?.schedule ?? task.schedule ?? null,
          language,
          revision,
        );
        resolvedTasks = upsertTask(resolvedTasks, updatedTask);
      } catch (error) {
        resolvedTasks = upsertTask(
          resolvedTasks,
          isRevisionConflict(error)
            ? createConflictTask(resolvedTasks, task, 'schedule')
            : markTaskSyncFailed(task, error)
        );
      }
      continue;
    }


    if (task.syncState === TASK_SYNC_STATE.pendingDelegation) {
      const remoteId = getTaskRemoteId(task);
      const freshRemote = resolvedTasks.find((candidate) => getTaskRemoteId(candidate) === remoteId);
      const revision = Number.isInteger(task.revision) ? task.revision : freshRemote?.revision;
      try {
        const updatedTask = await updateRemoteTaskDelegation(
          remoteId,
          task.pendingIntent?.delegation ?? null,
          language,
          revision,
        );
        resolvedTasks = upsertTask(resolvedTasks, updatedTask);
      } catch (error) {
        resolvedTasks = upsertTask(resolvedTasks,
          isRevisionConflict(error)
            ? createConflictTask(resolvedTasks, task, 'delegation')
            : markTaskSyncFailed(task, error));
      }
      continue;
    }

    if (task.syncState === TASK_SYNC_STATE.pendingDelegationStatus) {
      const remoteId = getTaskRemoteId(task);
      const freshRemote = resolvedTasks.find((candidate) => getTaskRemoteId(candidate) === remoteId);
      const revision = Number.isInteger(task.revision) ? task.revision : freshRemote?.revision;
      try {
        const updatedTask = await transitionRemoteTaskDelegation(
          remoteId,
          task.pendingIntent?.status,
          language,
          revision,
        );
        resolvedTasks = upsertTask(resolvedTasks, updatedTask);
      } catch (error) {
        resolvedTasks = upsertTask(resolvedTasks,
          isRevisionConflict(error)
            ? createConflictTask(resolvedTasks, task, 'delegation_status')
            : markTaskSyncFailed(task, error));
      }
      continue;
    }

    if (task.syncState === TASK_SYNC_STATE.pendingDelete) {
      const remoteId = getTaskRemoteId(task);
      const freshRemote = resolvedTasks.find((candidate) => getTaskRemoteId(candidate) === remoteId);
      const revision = Number.isInteger(task.revision) ? task.revision : freshRemote?.revision;

      try {
        await deleteRemoteTask(remoteId, revision, task.lifecycleState);
        resolvedTasks = removeTask(resolvedTasks, task);
      } catch (error) {
        resolvedTasks = upsertTask(
          resolvedTasks,
          isRevisionConflict(error)
            ? createConflictTask(resolvedTasks, task, 'delete')
            : markTaskSyncFailed(task, error)
        );
      }
    }

    if (task.syncState === TASK_SYNC_STATE.pendingLifecycle) {
      const remoteId = getTaskRemoteId(task);
      const freshRemote = resolvedTasks.find((candidate) => getTaskRemoteId(candidate) === remoteId);
      const revision = Number.isInteger(task.revision) ? task.revision : freshRemote?.revision;
      const action = task.pendingIntent?.action;
      try {
        const transitionedTask = await transitionRemoteTaskLifecycle(
          remoteId,
          action,
          language,
          revision,
        );
        resolvedTasks = upsertTask(resolvedTasks, transitionedTask);
      } catch (error) {
        resolvedTasks = upsertTask(
          resolvedTasks,
          isRevisionConflict(error)
            ? createConflictTask(resolvedTasks, task, 'lifecycle')
            : markTaskSyncFailed(task, error)
        );
      }
    }
  }

  return resolvedTasks;
}

export function hasPendingTasks(tasks) {
  return tasks.some(
    (task) => isTaskPendingSync(task) || task?.syncState === TASK_SYNC_STATE.conflict
  );
}
