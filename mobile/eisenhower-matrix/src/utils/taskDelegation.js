const ASSIGNMENT_FIELDS = new Set(['assigneeUserId', 'displayLabel', 'handoffNote']);
const STATUSES = new Set(['offered', 'accepted', 'in_progress', 'blocked', 'completed', 'declined']);
const TIMESTAMP_FIELDS = [
  'offeredAt', 'statusUpdatedAt', 'acceptedAt', 'inProgressAt', 'blockedAt', 'completedAt', 'declinedAt',
];
const TRANSITIONS = {
  offered: ['accepted', 'declined'],
  accepted: ['in_progress', 'declined'],
  in_progress: ['blocked', 'completed'],
  blocked: ['in_progress', 'completed'],
  completed: [],
  declined: [],
};

export function validateDelegationAssignment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, field: 'delegation' };
  }
  if (Object.keys(value).some((field) => !ASSIGNMENT_FIELDS.has(field))) {
    return { valid: false, field: 'fields' };
  }
  const assigneeUserId = typeof value.assigneeUserId === 'string' ? value.assigneeUserId.trim() : '';
  const displayLabel = typeof value.displayLabel === 'string' ? value.displayLabel.trim() : '';
  const handoffNote = typeof value.handoffNote === 'string' ? value.handoffNote.trim() : '';
  if (!assigneeUserId || assigneeUserId.length > 128) {
    return { valid: false, field: 'assigneeUserId' };
  }
  if (!displayLabel || displayLabel.length > 120) {
    return { valid: false, field: 'displayLabel' };
  }
  if (handoffNote.length > 1000) {
    return { valid: false, field: 'handoffNote' };
  }
  return { valid: true, delegation: { assigneeUserId, displayLabel, handoffNote } };
}

export function normalizeTaskDelegation(value) {
  if (!value || typeof value !== 'object') return null;
  const assignment = {
    assigneeUserId: String(value.assigneeUserId || '').trim(),
    displayLabel: String(value.displayLabel || '').trim(),
    handoffNote: String(value.handoffNote || '').trim(),
  };
  if (!assignment.assigneeUserId || !assignment.displayLabel) return null;
  const normalized = {
    ...assignment,
    status: STATUSES.has(value.status) ? value.status : 'offered',
  };
  TIMESTAMP_FIELDS.forEach((field) => {
    if (typeof value[field] === 'string' && !Number.isNaN(Date.parse(value[field]))) {
      normalized[field] = value[field];
    }
  });
  return normalized;
}

export function delegationStatusActions(status) {
  return TRANSITIONS[status] || [];
}
