export interface TaskScope {
  tenantId: string;
  ownerId: string;
}

export const TASK_LIFECYCLE_STATES = ['active', 'completed', 'archived', 'trashed'] as const;
export type TaskLifecycleState = (typeof TASK_LIFECYCLE_STATES)[number];
export type TaskLifecycleFilter = TaskLifecycleState | 'all';

export const TASK_LIFECYCLE_ACTIONS = [
  'complete',
  'reopen',
  'archive',
  'trash',
  'restore',
] as const;
export type TaskLifecycleAction = (typeof TASK_LIFECYCLE_ACTIONS)[number];

export const TASK_DELEGATION_STATUSES = [
  'offered',
  'accepted',
  'in_progress',
  'blocked',
  'completed',
  'declined',
] as const;
export type TaskDelegationStatus = (typeof TASK_DELEGATION_STATUSES)[number];

export interface TaskDelegationAssignment {
  assigneeUserId: string;
  displayLabel: string;
  handoffNote: string;
}

export interface TaskDelegation extends TaskDelegationAssignment {
  status: TaskDelegationStatus;
  offeredAt: Date;
  statusUpdatedAt: Date;
  acceptedAt?: Date;
  inProgressAt?: Date;
  blockedAt?: Date;
  completedAt?: Date;
  declinedAt?: Date;
}

export interface TaskPrincipalScope {
  tenantId: string;
  userId: string;
}

const DELEGATION_TRANSITIONS: Record<TaskDelegationStatus, readonly TaskDelegationStatus[]> = {
  offered: ['accepted', 'declined'],
  accepted: ['in_progress', 'declined'],
  in_progress: ['blocked', 'completed'],
  blocked: ['in_progress', 'completed'],
  completed: [],
  declined: [],
};

export function canTransitionDelegation(
  current: TaskDelegationStatus,
  target: TaskDelegationStatus
) {
  return DELEGATION_TRANSITIONS[current].includes(target);
}

export function resolveLifecycleTransition(
  current: TaskLifecycleState,
  previous: Exclude<TaskLifecycleState, 'trashed'> | undefined,
  action: TaskLifecycleAction
): { state: TaskLifecycleState; previous?: Exclude<TaskLifecycleState, 'trashed'> } | null {
  if (action === 'complete' && current === 'active') return { state: 'completed' };
  if (action === 'reopen' && current === 'completed') return { state: 'active' };
  if (action === 'archive' && (current === 'active' || current === 'completed')) {
    return { state: 'archived' };
  }
  if (action === 'trash' && current !== 'trashed') {
    return { state: 'trashed', previous: current };
  }
  if (action === 'restore' && current === 'archived') return { state: 'active' };
  if (action === 'restore' && current === 'trashed') return { state: previous ?? 'active' };
  return null;
}

export interface TaskPayload {
  title: string;
  description: string;
  urgent: boolean;
  important: boolean;
}

export interface TaskSchedule {
  dueAt: Date;
  timeZone: string;
  remindAt?: Date;
}

export interface StoredTask extends TaskScope, TaskPayload {
  _id: string;
  projectId?: string;
  lifecycleState: TaskLifecycleState;
  schedule?: TaskSchedule;
  delegation?: TaskDelegation;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export type LifecycleTransitionResult =
  | { status: 'updated'; task: StoredTask }
  | { status: 'invalid_transition' }
  | { status: 'not_found' }
  | { status: 'revision_conflict' };

export type DelegationTransitionResult =
  | { status: 'updated'; task: StoredTask }
  | { status: 'invalid_transition' }
  | { status: 'not_found' }
  | { status: 'revision_conflict' };

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
  get(scope: TaskScope, id: string): Promise<StoredTask | null>;
  listPage(
    scope: TaskScope,
    limit: number,
    cursor?: TaskPageCursor,
    lifecycle?: TaskLifecycleFilter
  ): Promise<{
    tasks: StoredTask[];
    hasNextPage: boolean;
  }>;
  create(
    scope: TaskScope,
    payload: TaskPayload,
    operation?: CreateOperation
  ): Promise<CreateTaskPersistenceResult>;
  update(
    scope: TaskScope,
    id: string,
    expectedRevision: number,
    patch: Partial<TaskPayload>
  ): Promise<StoredTask | null>;
  transitionLifecycle(
    scope: TaskScope,
    id: string,
    expectedRevision: number,
    action: TaskLifecycleAction
  ): Promise<LifecycleTransitionResult>;
  updateSchedule(
    scope: TaskScope,
    id: string,
    expectedRevision: number,
    schedule: TaskSchedule | null
  ): Promise<StoredTask | null>;
  listDelegated(
    scope: TaskPrincipalScope,
    limit: number,
    lifecycle: TaskLifecycleFilter
  ): Promise<StoredTask[]>;
  updateDelegation(
    scope: TaskScope,
    id: string,
    expectedRevision: number,
    delegation: TaskDelegationAssignment | null
  ): Promise<StoredTask | null>;
  transitionDelegation(
    scope: TaskPrincipalScope,
    id: string,
    expectedRevision: number,
    status: TaskDelegationStatus
  ): Promise<DelegationTransitionResult>;
  getLifecycleState(scope: TaskScope, id: string): Promise<TaskLifecycleState | null>;
  delete(scope: TaskScope, id: string, expectedRevision: number): Promise<StoredTask | null>;
  exists(scope: TaskScope, id: string): Promise<boolean>;
}
