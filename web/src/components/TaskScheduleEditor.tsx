import { FormEvent, useRef, useState } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import type { Task, TaskSchedule } from '../types';

interface Props {
  task: Task;
  onSave: (id: string, schedule: TaskSchedule | null) => Promise<void>;
  readOnly?: boolean;
}

function zonedParts(instant: Date, timeZone: string) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
}

function instantToLocalInput(instant: string, timeZone: string) {
  const parts = zonedParts(new Date(instant), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function localInputToUtc(localValue: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localValue)) {
    throw new Error('Invalid local date and time');
  }
  new Intl.DateTimeFormat('en-US', { timeZone }).format();
  const [date, time] = localValue.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let estimate = target;

  for (let index = 0; index < 3; index += 1) {
    const parts = zonedParts(new Date(estimate), timeZone);
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    estimate = target - (represented - estimate);
  }

  if (instantToLocalInput(new Date(estimate).toISOString(), timeZone) !== localValue) {
    throw new Error('Local time does not exist in this timezone');
  }
  return new Date(estimate).toISOString();
}

export default function TaskScheduleEditor({ task, onSave, readOnly = false }: Props) {
  const { language, t } = useLanguage();
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [dueAt, setDueAt] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(task.schedule?.durationMinutes ?? 30);
  const [timeZone, setTimeZone] = useState(
    task.schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const openEditor = () => {
    const zone = task.schedule?.timeZone ?? timeZone;
    setTimeZone(zone);
    setDueAt(task.schedule ? instantToLocalInput(task.schedule.dueAt, zone) : '');
    setRemindAt(task.schedule?.remindAt ? instantToLocalInput(task.schedule.remindAt, zone) : '');
    setDurationMinutes(task.schedule?.durationMinutes ?? 30);
    setError(null);
    setEditing(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const schedule: TaskSchedule = {
        dueAt: localInputToUtc(dueAt, timeZone),
        timeZone,
        durationMinutes,
        ...(remindAt ? { remindAt: localInputToUtc(remindAt, timeZone) } : {}),
      };
      if (schedule.remindAt && Date.parse(schedule.remindAt) > Date.parse(schedule.dueAt)) {
        setError(t('schedule.error.order'));
        return;
      }
      setSaving(true);
      await onSave(task._id, schedule);
      setEditing(false);
      setError(null);
      requestAnimationFrame(() => actionRef.current?.focus());
    } catch {
      setError(t('schedule.error.invalid'));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    try {
      await onSave(task._id, null);
      setError(null);
      requestAnimationFrame(() => actionRef.current?.focus());
    } catch {
      setError(t('status.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const formatInstant = (instant: string, zone: string) =>
    new Intl.DateTimeFormat(language === 'pl' ? 'pl-PL' : 'en-GB', {
      timeZone: zone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(instant));

  return (
    <div className="mt-3 border-t border-white/10 pt-3 text-xs text-white/75">
      {task.schedule ? (
        <div className="space-y-1">
          <p>
            <span className="font-semibold text-white">{t('schedule.due')}:</span>{' '}
            <time dateTime={task.schedule.dueAt}>
              {formatInstant(task.schedule.dueAt, task.schedule.timeZone)}
            </time>{' '}
            <span className="text-cyan-100">[{task.schedule.timeZone}]</span>
          </p>
          {task.schedule.remindAt ? (
            <p>
              {t('schedule.reminder')}:{' '}
              <time dateTime={task.schedule.remindAt}>
                {formatInstant(task.schedule.remindAt, task.schedule.timeZone)}
              </time>{' '}
              <span className="text-cyan-100">[{task.schedule.timeZone}]</span>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-white/50">{t('schedule.none')}</p>
      )}

      {readOnly ? null : editing ? (
        <form
          aria-label={`${t('schedule.edit')} ${task.title}`}
          onSubmit={submit}
          className="mt-3 grid gap-2 rounded-2xl bg-white/5 p-3 sm:grid-cols-2"
        >
          <label className="grid gap-1">
            <span>{t('schedule.due')}</span>
            <input
              type="datetime-local"
              required
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
              className="rounded-lg border border-white/15 bg-slate-950 px-2 py-1.5 text-white"
            />
          </label>
          <label className="grid gap-1">
            <span>{t('schedule.timeZone')}</span>
            <input
              required
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              autoComplete="off"
              className="rounded-lg border border-white/15 bg-slate-950 px-2 py-1.5 text-white"
            />
          </label>
          <label className="grid gap-1">
            <span>{t('schedule.reminder')}</span>
            <input
              type="datetime-local"
              value={remindAt}
              onChange={(event) => setRemindAt(event.target.value)}
              className="rounded-lg border border-white/15 bg-slate-950 px-2 py-1.5 text-white"
            />
          </label>
          <label className="grid gap-1">
            <span>{t('schedule.duration')}</span>
            <input
              type="number"
              min={5}
              max={1440}
              step={5}
              required
              value={durationMinutes}
              onChange={(event) => setDurationMinutes(Number(event.target.value))}
              className="rounded-lg border border-white/15 bg-slate-950 px-2 py-1.5 text-white"
            />
          </label>
          <div className="flex items-end gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-full bg-cyan-200 px-3 py-1.5 font-semibold text-slate-950 disabled:opacity-50"
            >
              {t('schedule.save')}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-full bg-white/10 px-3 py-1.5"
            >
              {t('task.cancelDelete')}
            </button>
          </div>
          {error ? (
            <p role="alert" className="text-red-200 sm:col-span-2">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            ref={actionRef}
            type="button"
            onClick={openEditor}
            aria-label={`${task.schedule ? t('schedule.edit') : t('schedule.add')} ${task.title}`}
            className="rounded-full bg-white/10 px-3 py-1.5 hover:bg-white/15"
          >
            {task.schedule ? t('schedule.edit') : t('schedule.add')}
          </button>
          {task.schedule ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => void clear()}
              aria-label={`${t('schedule.clear')} ${task.title}`}
              className="rounded-full bg-white/10 px-3 py-1.5 hover:bg-white/15 disabled:opacity-50"
            >
              {t('schedule.clear')}
            </button>
          ) : null}
        </div>
      )}
      {!editing && error ? (
        <p role="alert" className="mt-2 text-red-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}
