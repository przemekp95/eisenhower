import {
  classifyTaskFallback,
  createTaskRecord,
  flagsToQuadrant,
  getSampleTasks,
  groupTasksByQuadrant,
  mergeTasks,
  quadrantToFlags,
} from './taskUtils';

describe('taskUtils', () => {
  it('builds localized sample tasks', () => {
    expect(getSampleTasks('pl')[0].title).toMatch(/Pilny/);
    expect(getSampleTasks('en')[0].title).toMatch(/Urgent/);
  });

  it('classifies fallback urgency and importance', () => {
    expect(classifyTaskFallback('urgent client deadline')).toEqual({ urgent: true, important: true });
    expect(classifyTaskFallback('watch series')).toEqual({ urgent: false, important: false });
  });

  it('maps quadrants to task flags', () => {
    expect(quadrantToFlags(0)).toEqual({ urgent: true, important: true });
    expect(quadrantToFlags(3)).toEqual({ urgent: false, important: false });
  });

  it('maps task flags back to a quadrant index', () => {
    expect(flagsToQuadrant({ urgent: true, important: true })).toBe(0);
    expect(flagsToQuadrant({ urgent: true, important: false })).toBe(1);
    expect(flagsToQuadrant({ urgent: false, important: true })).toBe(2);
    expect(flagsToQuadrant({ urgent: false, important: false })).toBe(3);
  });

  it('creates normalized records', () => {
    expect(createTaskRecord('pl', { title: '  Task ', description: ' desc ', urgent: true, important: false }, '1')).toEqual({
      id: '1',
      title: 'Task',
      description: 'desc',
      urgent: true,
      important: false,
      locale: 'pl',
      remoteId: null,
      syncState: 'pending_create',
    });
  });

  it('merges tasks without duplicates or blank titles', () => {
    expect(
      mergeTasks(
        [{ id: '1', title: 'Existing', description: '', urgent: false, important: false }],
        [
          { id: '2', title: 'Existing', description: '', urgent: true, important: true },
          { id: '3', title: 'Fresh', description: 'new', urgent: false, important: true },
          { id: '4', title: '   ', description: '', urgent: false, important: false },
        ]
      )
    ).toEqual([
      { id: '2', title: 'Existing', description: '', urgent: true, important: true },
      { id: '3', title: 'Fresh', description: 'new', urgent: false, important: true },
    ]);
  });

  it('groups tasks into all four quadrants', () => {
    expect(
      groupTasksByQuadrant([
        { id: '1', title: 'Now', description: '', urgent: true, important: true },
        { id: '2', title: 'Delegate', description: '', urgent: true, important: false },
        { id: '3', title: 'Schedule', description: '', urgent: false, important: true },
        { id: '4', title: 'Drop', description: '', urgent: false, important: false },
        { id: '5', title: 'Hidden delete', description: '', urgent: true, important: false, syncState: 'pending_delete' },
      ])
    ).toEqual({
      0: [{ id: '1', title: 'Now', description: '', urgent: true, important: true }],
      1: [{ id: '2', title: 'Delegate', description: '', urgent: true, important: false }],
      2: [{ id: '3', title: 'Schedule', description: '', urgent: false, important: true }],
      3: [{ id: '4', title: 'Drop', description: '', urgent: false, important: false }],
    });
  });
});
