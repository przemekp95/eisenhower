import {
  classifyTaskFallback,
  createTaskRecord,
  getSampleTasks,
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

  it('creates normalized records', () => {
    expect(createTaskRecord('pl', { title: '  Task ', description: ' desc ', urgent: true, important: false }, '1')).toEqual({
      id: '1',
      title: 'Task',
      description: 'desc',
      urgent: true,
      important: false,
      locale: 'pl',
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
});
