export const TASK_SYNC_STATE = {
  synced: 'synced',
  pendingCreate: 'pending_create',
  pendingUpdate: 'pending_update',
  pendingDelete: 'pending_delete',
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
      syncState === TASK_SYNC_STATE.pendingDelete)
  ) {
    syncState = id.startsWith('seed-')
      ? TASK_SYNC_STATE.localSeed
      : TASK_SYNC_STATE.pendingCreate;
  }

  return {
    id,
    title: String(task?.title || '').trim(),
    description: String(task?.description || '').trim(),
    urgent: Boolean(task?.urgent),
    important: Boolean(task?.important),
    locale: task?.locale || language,
    remoteId,
    syncState,
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
    },
    language
  );
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
    },
    task.locale
  );
}

export function markTaskPendingDelete(task) {
  if (!getTaskRemoteId(task)) {
    return null;
  }

  return normalizeStoredTask(
    {
      ...task,
      syncState: TASK_SYNC_STATE.pendingDelete,
    },
    task.locale
  );
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
  deleteRemoteTask,
}) {
  let resolvedTasks = normalizeStoredTasks(remoteTasks, language);

  for (const task of normalizeStoredTasks(cachedTasks, language).filter((item) => isTaskPendingSync(item))) {
    if (task.syncState === TASK_SYNC_STATE.pendingCreate) {
      try {
        const createdTask = await createRemoteTask(taskToRemotePayload(task), language);
        resolvedTasks = upsertTask(resolvedTasks, createdTask);
      } catch {
        resolvedTasks = upsertTask(resolvedTasks, task);
      }
      continue;
    }

    if (task.syncState === TASK_SYNC_STATE.pendingUpdate) {
      const remoteId = getTaskRemoteId(task);
      try {
        const updatedTask = await updateRemoteTask(remoteId, taskToRemotePayload(task), language);
        resolvedTasks = upsertTask(resolvedTasks, updatedTask);
      } catch {
        resolvedTasks = upsertTask(resolvedTasks, task);
      }
      continue;
    }

    if (task.syncState === TASK_SYNC_STATE.pendingDelete) {
      const remoteId = getTaskRemoteId(task);

      resolvedTasks = removeTask(resolvedTasks, task);

      try {
        await deleteRemoteTask(remoteId);
      } catch {
        resolvedTasks = upsertTask(resolvedTasks, task);
      }
    }
  }

  return resolvedTasks;
}

export function hasPendingTasks(tasks) {
  return tasks.some((task) => isTaskPendingSync(task));
}
