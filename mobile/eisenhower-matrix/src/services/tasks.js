import {
  createRequestError,
  createTaskApi,
  readJson,
  toTaskInputDto,
} from '@eisenhower/api-client';
import { mobileConfig } from '../config';
import { clearTokens, getAccessToken } from '../authSession';
import { TASK_SYNC_STATE, isRemoteTaskId as isRemoteObjectId } from '../utils/taskSync';
import { normalizeTaskDelegation } from '../utils/taskDelegation';

const TASK_PAGE_LIMIT = 200;
const MAX_TASK_PAGES = 1000;
const TASK_LIFECYCLE_ACTIONS = new Set(['complete', 'reopen', 'archive', 'trash', 'restore']);
const TASK_LIFECYCLE_STATES = new Set(['active', 'completed', 'archived', 'trashed']);
const TASK_DELEGATION_STATUSES = new Set(['accepted', 'in_progress', 'blocked', 'completed', 'declined']);

function getTaskApi() {
  return createTaskApi(mobileConfig.apiUrl, {
    accessToken: getAccessToken,
    onUnauthorized: clearTokens,
  });
}

async function authorizedTaskRequest(path, init = {}) {
  const token = getAccessToken();
  const headers = { ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await globalThis.fetch(`${mobileConfig.apiUrl}${path}`, { ...init, headers });
  if (response.status === 401) clearTokens();
  return response;
}

function taskRequestError() {
  return {
    defaultError: 'Task request failed',
    errorCode: 'task_request_failed',
  };
}

function requireRevision(revision) {
  if (!Number.isInteger(revision) || revision < 0) {
    throw createRequestError('A current task revision is required', {
      code: 'task_revision_required',
      status: 428,
    });
  }
  return revision;
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
    revision: Number.isInteger(task.revision) ? task.revision : 0,
    lifecycleState: TASK_LIFECYCLE_STATES.has(task.lifecycleState)
      ? task.lifecycleState
      : 'active',
    ...(task.schedule && typeof task.schedule === 'object'
      ? {
        schedule: {
          dueAt: String(task.schedule.dueAt),
          timeZone: String(task.schedule.timeZone),
          ...(task.schedule.remindAt ? { remindAt: String(task.schedule.remindAt) } : {}),
        },
      }
      : {}),
    ...(normalizeTaskDelegation(task.delegation)
      ? { delegation: normalizeTaskDelegation(task.delegation) }
      : {}),
  };
}

export async function fetchRemoteDelegatedTasks(language = 'pl') {
  const payload = await getTaskApi().listDelegatedTasks();
  return payload.map((task) => ({
    ...normalizeRemoteTask(task, language),
    delegationRole: 'assignee',
  }));
}

export async function fetchRemoteTasks(language = 'pl') {
  const tasks = [];
  const seenCursors = new Set();
  let cursor = null;

  for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
    const query = `?limit=${TASK_PAGE_LIMIT}&lifecycle=all${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = await authorizedTaskRequest(`/tasks${query}`);
    const payload = await readJson(response, taskRequestError());
    if (!Array.isArray(payload)) {
      throw createRequestError('Task list response must be an array', taskRequestError());
    }
    tasks.push(...payload);

    const nextCursor = response.headers?.get?.('x-next-cursor')?.trim() || null;
    if (!nextCursor) {
      return tasks.map((task) => normalizeRemoteTask(task, language));
    }
    if (seenCursors.has(nextCursor)) {
      throw createRequestError('Task pagination cursor repeated', {
        code: 'task_pagination_cycle',
      });
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw createRequestError('Task pagination exceeded the safe page limit', {
    code: 'task_pagination_limit',
  });
}

export async function createRemoteTask(task, language = 'pl', clientOperationId) {
  if (typeof clientOperationId !== 'string' || !clientOperationId) {
    throw createRequestError('A stable client operation id is required', {
      code: 'client_operation_required',
      status: 400,
    });
  }
  const response = await authorizedTaskRequest('/tasks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': clientOperationId,
    },
    body: JSON.stringify(toTaskInputDto(task)),
  });
  return normalizeRemoteTask(await readJson(response, taskRequestError()), language);
}

export async function updateRemoteTask(id, patch, language = 'pl', revision) {
  return normalizeRemoteTask(
    await getTaskApi().updateTask(id, patch, requireRevision(revision)),
    language,
  );
}

export async function transitionRemoteTaskLifecycle(id, action, language = 'pl', revision) {
  if (!TASK_LIFECYCLE_ACTIONS.has(action)) {
    throw createRequestError('Unsupported task lifecycle action', {
      code: 'invalid_lifecycle_action',
      status: 400,
    });
  }
  return normalizeRemoteTask(
    await getTaskApi().transitionTaskLifecycle(id, action, requireRevision(revision)),
    language,
  );
}

export async function updateRemoteTaskSchedule(id, schedule, language = 'pl', revision) {
  const response = await authorizedTaskRequest(`/tasks/${id}/schedule`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': `"${requireRevision(revision)}"`,
    },
    body: JSON.stringify({ schedule }),
  });
  return normalizeRemoteTask(await readJson(response, taskRequestError()), language);
}

export async function updateRemoteTaskDelegation(id, delegation, language = 'pl', revision) {
  return normalizeRemoteTask(
    await getTaskApi().updateTaskDelegation(id, delegation, requireRevision(revision)),
    language,
  );
}

export async function transitionRemoteTaskDelegation(id, status, language = 'pl', revision) {
  if (!TASK_DELEGATION_STATUSES.has(status)) {
    throw createRequestError('Unsupported delegation status', {
      code: 'invalid_delegation_status', status: 400,
    });
  }
  return {
    ...normalizeRemoteTask(
      await getTaskApi().transitionTaskDelegation(id, status, requireRevision(revision)),
      language,
    ),
    delegationRole: 'assignee',
  };
}

export async function deleteRemoteTask(id, revision, lifecycleState) {
  const requiredRevision = requireRevision(revision);
  if (lifecycleState !== 'trashed') {
    throw createRequestError('Task must be trashed before final deletion', {
      code: 'task_not_trashed',
      status: 409,
    });
  }
  await getTaskApi().deleteTask(id, requiredRevision);
}
