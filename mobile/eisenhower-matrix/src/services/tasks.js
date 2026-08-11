import { createTaskApi } from '@eisenhower/api-client';
import { mobileConfig } from '../config';
import { clearTokens, getAccessToken } from '../authSession';
import { TASK_SYNC_STATE, isRemoteTaskId as isRemoteObjectId } from '../utils/taskSync';

function getTaskApi() {
  return createTaskApi(mobileConfig.apiUrl, {
    accessToken: getAccessToken,
    onUnauthorized: clearTokens,
  });
}

export function isRemoteTaskId(id) {
  return isRemoteObjectId(id);
}

export function normalizeRemoteTask(task, language = 'pl') {
  const remoteId = String(task._id || task.id);

  return {
    id: remoteId,
    title: String(task.title || '').trim(),
    description: String(task.description || '').trim(),
    urgent: Boolean(task.urgent),
    important: Boolean(task.important),
    locale: task.locale || language,
    remoteId,
    syncState: TASK_SYNC_STATE.synced,
    ...(Number.isInteger(task.revision) ? { revision: task.revision } : {}),
  };
}

export async function fetchRemoteTasks(language = 'pl') {
  const tasks = await getTaskApi().listTasks();
  return tasks.map((task) => normalizeRemoteTask(task, language));
}

export async function createRemoteTask(task, language = 'pl') {
  return normalizeRemoteTask(await getTaskApi().createTask(task), language);
}

export async function updateRemoteTask(id, patch, language = 'pl', revision) {
  return normalizeRemoteTask(await getTaskApi().updateTask(id, patch, revision), language);
}

export async function deleteRemoteTask(id, revision) {
  await getTaskApi().deleteTask(id, revision);
}
