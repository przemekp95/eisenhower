import { createTaskApi } from '@eisenhower/api-client';
import { mobileConfig } from '../config';
import { TASK_SYNC_STATE, isRemoteTaskId as isRemoteObjectId } from '../utils/taskSync';

function getTaskApi() {
  return createTaskApi(mobileConfig.apiUrl);
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
  };
}

export async function fetchRemoteTasks(language = 'pl') {
  const tasks = await getTaskApi().listTasks();
  return tasks.map((task) => normalizeRemoteTask(task, language));
}

export async function createRemoteTask(task, language = 'pl') {
  return normalizeRemoteTask(await getTaskApi().createTask(task), language);
}

export async function updateRemoteTask(id, patch, language = 'pl') {
  return normalizeRemoteTask(await getTaskApi().updateTask(id, patch), language);
}

export async function deleteRemoteTask(id) {
  await getTaskApi().deleteTask(id);
}
