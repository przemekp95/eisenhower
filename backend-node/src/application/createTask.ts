import { createHash } from 'node:crypto';
import {
  TaskPayload,
  TaskRepository,
  TaskScope,
} from './taskRepository';

export class IdempotencyKeyReuseError extends Error {
  readonly code = 'idempotency_key_reused';

  constructor() {
    super('Idempotency key was already used with a different task payload');
  }
}

export class IdempotencyResultDeletedError extends Error {
  readonly code = 'idempotency_result_deleted';

  constructor() {
    super('The task created by this idempotency key was deleted');
  }
}

function payloadDigest(payload: TaskPayload) {
  return createHash('sha256').update(JSON.stringify({
    title: payload.title,
    description: payload.description,
    urgent: payload.urgent,
    important: payload.important,
  })).digest('hex');
}

export async function createTask(
  repository: TaskRepository,
  scope: TaskScope,
  payload: TaskPayload,
  clientOperationId?: string,
) {
  const digest = clientOperationId ? payloadDigest(payload) : undefined;
  const result = await repository.create(
    scope,
    payload,
    clientOperationId && digest
      ? { id: clientOperationId, payloadDigest: digest }
      : undefined,
  );

  if (digest && result.storedPayloadDigest !== digest) {
    throw new IdempotencyKeyReuseError();
  }
  if (result.operationDeleted) {
    throw new IdempotencyResultDeletedError();
  }

  return result;
}
