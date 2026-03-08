import {
  classifyTaskFallback,
  createTaskRecord,
  getSampleTasks,
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
});
