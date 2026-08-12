import { formatTaskSchedule, validateTaskSchedule } from './taskSchedule';

describe('task schedule contract', () => {
  const schedule = {
    dueAt: '2026-08-15T12:00:00.000Z',
    timeZone: 'Europe/Warsaw',
    remindAt: '2026-08-15T10:00:00.000Z',
  };

  it('accepts the backend UTC/IANA contract and formats in the chosen timezone', () => {
    expect(validateTaskSchedule(schedule)).toEqual({ valid: true, schedule });
    expect(formatTaskSchedule(schedule, 'pl')).toContain('14:00');
  });

  it.each([
    [{ ...schedule, dueAt: '2026-08-15T14:00:00+02:00' }, 'dueAt'],
    [{ ...schedule, timeZone: 'Mars/Olympus' }, 'timeZone'],
    [{ ...schedule, remindAt: '2026-08-15T12:00:01.000Z' }, 'remindAt'],
    [{ ...schedule, recurrence: 'daily' }, 'fields'],
  ])('fails closed for invalid schedules', (value, field) => {
    expect(validateTaskSchedule(value)).toEqual(expect.objectContaining({ valid: false, field }));
  });

  it('rejects non-objects and accepts a due date without a reminder', () => {
    expect(validateTaskSchedule(null)).toEqual({ valid: false, field: 'schedule' });
    expect(validateTaskSchedule([])).toEqual({ valid: false, field: 'schedule' });
    expect(validateTaskSchedule({ ...schedule, timeZone: '' }))
      .toEqual({ valid: false, field: 'timeZone' });
    expect(validateTaskSchedule({ ...schedule, remindAt: 'invalid' }))
      .toEqual({ valid: false, field: 'remindAt' });
    const { remindAt: _remindAt, ...withoutReminder } = schedule;
    expect(validateTaskSchedule(withoutReminder)).toEqual({ valid: true, schedule: withoutReminder });
    expect(formatTaskSchedule(null)).toBe('');
    expect(formatTaskSchedule(withoutReminder, 'en')).toContain('14:00');
  });
});
