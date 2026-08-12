export interface TaskScope {
  tenantId: string;
  ownerId: string;
}

export interface TaskPayload {
  title: string;
  description: string;
  urgent: boolean;
  important: boolean;
}

export interface StoredTask extends TaskScope, TaskPayload {
  _id: string;
  projectId?: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskPageCursor {
  createdAt: Date;
  id: string;
}

export interface CreateOperation {
  id: string;
  payloadDigest: string;
}

export interface CreateTaskPersistenceResult {
  task: StoredTask;
  replayed: boolean;
  storedPayloadDigest?: string;
  operationDeleted?: boolean;
}

export interface TaskRepository {
  listPage(scope: TaskScope, limit: number, cursor?: TaskPageCursor): Promise<{
    tasks: StoredTask[];
    hasNextPage: boolean;
  }>;
  create(
    scope: TaskScope,
    payload: TaskPayload,
    operation?: CreateOperation,
  ): Promise<CreateTaskPersistenceResult>;
  update(
    scope: TaskScope,
    id: string,
    expectedRevision: number,
    patch: Partial<TaskPayload>,
  ): Promise<StoredTask | null>;
  delete(scope: TaskScope, id: string, expectedRevision: number): Promise<StoredTask | null>;
  exists(scope: TaskScope, id: string): Promise<boolean>;
}
