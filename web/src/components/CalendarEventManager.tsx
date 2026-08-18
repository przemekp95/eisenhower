import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CalendarEventCandidateDto,
  CalendarLinkPreviewDto,
  TaskDto,
} from '@eisenhower/api-client';
import {
  createCalendarLink,
  getCalendarEvents,
  getTasks,
  importCalendarEvents,
  previewCalendarLink,
} from '../services/api';
import { useLanguage } from '../i18n/LanguageContext';

function operationId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export default function CalendarEventManager() {
  const { t } = useLanguage();
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [events, setEvents] = useState<CalendarEventCandidateDto[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [taskId, setTaskId] = useState('');
  const [eventId, setEventId] = useState('');
  const [preview, setPreview] = useState<CalendarLinkPreviewDto | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const importKey = useRef<string | null>(null);
  const linkKeys = useRef(new Map<string, string>());
  const windowRange = useMemo(() => {
    const min = new Date();
    min.setDate(min.getDate() - 30);
    const max = new Date();
    max.setDate(max.getDate() + 90);
    return { timeMin: min.toISOString(), timeMax: max.toISOString() };
  }, []);

  useEffect(() => {
    void Promise.all([
      getTasks('active'),
      getCalendarEvents(windowRange.timeMin, windowRange.timeMax),
    ])
      .then(([nextTasks, result]) => {
        setTasks(Array.isArray(nextTasks) ? nextTasks : []);
        setEvents(Array.isArray(result?.events) ? result.events : []);
      })
      .catch(() => setMessage(t('calendar.error')));
  }, [t, windowRange]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const importSelected = async () => {
    if (!selected.size) return;
    setBusy(true);
    importKey.current ??= operationId('calendar-selected-import');
    try {
      const result = await importCalendarEvents([...selected], importKey.current);
      const completed = new Set(
        result.results
          .filter((item) => item.status !== 'failed')
          .map((item) => item.providerEventId)
      );
      setSelected((current) => new Set([...current].filter((id) => !completed.has(id))));
      setEvents((current) => current.filter((event) => !completed.has(event.id)));
      if (!result.results.some((item) => item.status === 'failed')) importKey.current = null;
      setMessage(
        t('calendar.importResult')
          .replace('{ok}', String(completed.size))
          .replace('{total}', String(result.results.length))
      );
    } catch {
      setMessage(t('calendar.error'));
    } finally {
      setBusy(false);
    }
  };

  const showPreview = async () => {
    if (!taskId || !eventId) return;
    setBusy(true);
    try {
      setPreview(await previewCalendarLink(taskId, eventId));
    } catch {
      setMessage(t('calendar.error'));
    } finally {
      setBusy(false);
    }
  };

  const link = async (direction: 'google_to_eisenhower' | 'eisenhower_to_google') => {
    if (!preview) return;
    const key = `${preview.task.id}:${preview.event.id}:${direction}`;
    const idempotencyKey = linkKeys.current.get(key) ?? operationId('calendar-manual-link');
    linkKeys.current.set(key, idempotencyKey);
    setBusy(true);
    try {
      await createCalendarLink({
        taskId: preview.task.id,
        providerEventId: preview.event.id,
        providerEtag: preview.event.etag,
        direction,
        taskRevision: preview.task.revision,
        idempotencyKey,
      });
      linkKeys.current.delete(key);
      setEvents((current) => current.filter((event) => event.id !== preview.event.id));
      setPreview(null);
      setTaskId('');
      setEventId('');
      setMessage(t('calendar.linked'));
    } catch {
      setMessage(t('calendar.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="calendar-events-heading"
      className="mt-5 border-t border-white/10 pt-4"
    >
      <h3 id="calendar-events-heading" className="font-semibold">
        {t('calendar.selectedEvents')}
      </h3>
      <p className="mt-1 text-sm text-slate-300">{t('calendar.noAutomaticImport')}</p>
      <div className="mt-3 max-h-64 space-y-2 overflow-auto">
        {events.map((event) => (
          <label
            key={event.id}
            className="flex min-h-11 items-center gap-3 rounded-xl bg-white/5 px-3 py-2"
          >
            <input
              type="checkbox"
              checked={selected.has(event.id)}
              onChange={() => toggle(event.id)}
              aria-label={`${event.title} — ${t('calendar.selectEvent')}`}
            />
            <span className="min-w-0">
              <span className="block truncate font-medium">{event.title}</span>
              <time className="text-xs text-slate-400" dateTime={event.start}>
                {new Date(event.start).toLocaleString()}
              </time>
            </span>
          </label>
        ))}
      </div>
      <button
        type="button"
        disabled={!selected.size || busy}
        onClick={() => void importSelected()}
        className="mt-3 min-h-11 rounded-lg bg-cyan-200 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
      >
        {t('calendar.importSelected')}
      </button>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span>{t('calendar.eisenhowerTask')}</span>
          <select
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            className="rounded-lg bg-slate-950 p-2"
          >
            <option value="">—</option>
            {tasks.map((task) => (
              <option key={task._id} value={task._id}>
                {task.title}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>{t('calendar.googleEvent')}</span>
          <select
            value={eventId}
            onChange={(event) => setEventId(event.target.value)}
            className="rounded-lg bg-slate-950 p-2"
          >
            <option value="">—</option>
            {events.map((event) => (
              <option key={event.id} value={event.id}>
                {event.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="button"
        disabled={!taskId || !eventId || busy}
        onClick={() => void showPreview()}
        className="mt-3 min-h-11 rounded-lg border border-white/15 px-3 py-2 text-sm disabled:opacity-50"
      >
        {t('calendar.previewDifferences')}
      </button>

      {preview ? (
        <div className="mt-3 rounded-xl border border-amber-200/30 p-3">
          <p>
            {t('calendar.previewLocal')}: {preview.task.title}
          </p>
          <p>
            {t('calendar.previewGoogle')}: {preview.event.title}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void link('google_to_eisenhower')}
              className="min-h-11 rounded-lg border border-white/15 px-3 py-2 text-sm"
            >
              {t('calendar.useGoogle')}
            </button>
            <button
              type="button"
              disabled={busy || !preview.eisenhowerToGoogle.schedule}
              onClick={() => void link('eisenhower_to_google')}
              className="min-h-11 rounded-lg border border-white/15 px-3 py-2 text-sm"
            >
              {t('calendar.keepEisenhower')}
            </button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p role="status" className="mt-2 text-sm text-amber-100">
          {message}
        </p>
      ) : null}
    </section>
  );
}
