import { mobileConfig } from '../config';

function isJsonResponse(response) {
  const contentType = response.headers?.get?.('content-type') ?? '';
  return contentType.includes('application/json');
}

async function readJson(response) {
  if (!response.ok) {
    if (isJsonResponse(response)) {
      const payload = await response.json();
      throw new Error(payload.error || 'Task request failed');
    }

    throw new Error('Task request failed');
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export function isRemoteTaskId(id) {
  return /^[a-f0-9]{24}$/i.test(String(id || ''));
}

export function normalizeRemoteTask(task, language = 'pl') {
  return {
    id: String(task._id || task.id),
    title: String(task.title || '').trim(),
    description: String(task.description || '').trim(),
    urgent: Boolean(task.urgent),
    important: Boolean(task.important),
    locale: task.locale || language,
  };
}

export async function fetchRemoteTasks(language = 'pl') {
  const response = await fetch(`${mobileConfig.apiUrl}/tasks`);
  const tasks = await readJson(response);
  return tasks.map((task) => normalizeRemoteTask(task, language));
}

export async function createRemoteTask(task, language = 'pl') {
  const response = await fetch(`${mobileConfig.apiUrl}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: task.title,
      description: task.description || '',
      urgent: Boolean(task.urgent),
      important: Boolean(task.important),
    }),
  });

  return normalizeRemoteTask(await readJson(response), language);
}

export async function updateRemoteTask(id, patch, language = 'pl') {
  const response = await fetch(`${mobileConfig.apiUrl}/tasks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.urgent !== undefined ? { urgent: Boolean(patch.urgent) } : {}),
      ...(patch.important !== undefined ? { important: Boolean(patch.important) } : {}),
    }),
  });

  return normalizeRemoteTask(await readJson(response), language);
}

export async function deleteRemoteTask(id) {
  const response = await fetch(`${mobileConfig.apiUrl}/tasks/${id}`, {
    method: 'DELETE',
  });

  await readJson(response);
}
