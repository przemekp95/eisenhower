const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SCHEDULE_FIELDS = new Set(['dueAt', 'timeZone', 'remindAt']);

function isUtcInstant(value) {
  return typeof value === 'string'
    && UTC_ISO_PATTERN.test(value)
    && !Number.isNaN(Date.parse(value));
}

export function isValidIanaTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function validateTaskSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, field: 'schedule' };
  }
  if (Object.keys(value).some((field) => !SCHEDULE_FIELDS.has(field))) {
    return { valid: false, field: 'fields' };
  }
  if (!isUtcInstant(value.dueAt)) {
    return { valid: false, field: 'dueAt' };
  }
  if (!isValidIanaTimeZone(value.timeZone)) {
    return { valid: false, field: 'timeZone' };
  }
  if (value.remindAt !== undefined) {
    if (!isUtcInstant(value.remindAt) || Date.parse(value.remindAt) > Date.parse(value.dueAt)) {
      return { valid: false, field: 'remindAt' };
    }
  }
  const schedule = {
    dueAt: value.dueAt,
    timeZone: value.timeZone,
    ...(value.remindAt ? { remindAt: value.remindAt } : {}),
  };
  return { valid: true, schedule };
}

export function normalizeTaskSchedule(value) {
  const result = validateTaskSchedule(value);
  return result.valid ? result.schedule : null;
}

export function formatTaskSchedule(schedule, language = 'pl') {
  const normalized = normalizeTaskSchedule(schedule);
  if (!normalized) return '';
  return new Intl.DateTimeFormat(language === 'pl' ? 'pl-PL' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: normalized.timeZone,
  }).format(new Date(normalized.dueAt));
}
