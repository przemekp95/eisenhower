import {
  delegationStatusActions,
  normalizeTaskDelegation,
  validateDelegationAssignment,
} from './taskDelegation';

describe('task delegation contract', () => {
  it('normalizes assignment, status and server timestamps', () => {
    expect(normalizeTaskDelegation({
      assigneeUserId: ' user-b ',
      displayLabel: ' Pat ',
      handoffNote: ' Runbook ',
      status: 'accepted',
      offeredAt: '2026-08-12T10:00:00.000Z',
      statusUpdatedAt: '2026-08-12T11:00:00.000Z',
      acceptedAt: '2026-08-12T11:00:00.000Z',
    })).toEqual({
      assigneeUserId: 'user-b',
      displayLabel: 'Pat',
      handoffNote: 'Runbook',
      status: 'accepted',
      offeredAt: '2026-08-12T10:00:00.000Z',
      statusUpdatedAt: '2026-08-12T11:00:00.000Z',
      acceptedAt: '2026-08-12T11:00:00.000Z',
    });
  });

  it('validates owner assignment limits and rejects caller-controlled fields', () => {
    expect(validateDelegationAssignment({ assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '' }))
      .toEqual({ valid: true, delegation: { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '' } });
    expect(validateDelegationAssignment({ assigneeUserId: '', displayLabel: 'Pat' })).toMatchObject({ valid: false, field: 'assigneeUserId' });
    expect(validateDelegationAssignment({ assigneeUserId: 'user-b', displayLabel: 'x'.repeat(121) })).toMatchObject({ valid: false, field: 'displayLabel' });
    expect(validateDelegationAssignment({ assigneeUserId: 'user-b', displayLabel: 'Pat', status: 'accepted' })).toMatchObject({ valid: false, field: 'fields' });
    expect(validateDelegationAssignment(null)).toMatchObject({ valid: false, field: 'delegation' });
    expect(validateDelegationAssignment([])).toMatchObject({ valid: false, field: 'delegation' });
    expect(validateDelegationAssignment({ assigneeUserId: 12, displayLabel: 'Pat' })).toMatchObject({ valid: false, field: 'assigneeUserId' });
    expect(validateDelegationAssignment({ assigneeUserId: 'user-b', displayLabel: 12 })).toMatchObject({ valid: false, field: 'displayLabel' });
    expect(validateDelegationAssignment({ assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: 12 }))
      .toEqual({ valid: true, delegation: { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '' } });
    expect(validateDelegationAssignment({ assigneeUserId: 'x'.repeat(129), displayLabel: 'Pat' }))
      .toMatchObject({ valid: false, field: 'assigneeUserId' });
    expect(validateDelegationAssignment({ assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: 'x'.repeat(1001) }))
      .toMatchObject({ valid: false, field: 'handoffNote' });
  });

  it('exposes only valid assignee transitions', () => {
    expect(delegationStatusActions('offered')).toEqual(['accepted', 'declined']);
    expect(delegationStatusActions('accepted')).toEqual(['in_progress', 'declined']);
    expect(delegationStatusActions('in_progress')).toEqual(['blocked', 'completed']);
    expect(delegationStatusActions('blocked')).toEqual(['in_progress', 'completed']);
    expect(delegationStatusActions('completed')).toEqual([]);
    expect(delegationStatusActions('unknown')).toEqual([]);
    expect(normalizeTaskDelegation(null)).toBeNull();
    expect(normalizeTaskDelegation({ assigneeUserId: '', displayLabel: '' })).toBeNull();
    expect(normalizeTaskDelegation({ assigneeUserId: 'user-b', displayLabel: 'Pat', status: 'unknown', offeredAt: 'invalid' }))
      .toEqual({ assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '', status: 'offered' });
    expect(normalizeTaskDelegation({ assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: null }))
      .toMatchObject({ handoffNote: '' });
  });
});
