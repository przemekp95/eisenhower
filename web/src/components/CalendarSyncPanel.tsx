import { useEffect, useState } from 'react';
import type { CalendarConflictDto, CalendarStatusDto } from '@eisenhower/api-client';
import {
  getCalendarConflicts,
  getCalendarStatus,
  requestCalendarSync,
  resolveCalendarConflict,
} from '../services/api';
import { useLanguage } from '../i18n/LanguageContext';

function operationId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export default function CalendarSyncPanel() {
  const { t } = useLanguage();
  const [status, setStatus] = useState<CalendarStatusDto | null>(null);
  const [conflicts, setConflicts] = useState<CalendarConflictDto[]>([]);
  const [message, setMessage] = useState('');

  const refresh = async () => {
    try {
      const nextStatus = await getCalendarStatus();
      setStatus(nextStatus);
      setConflicts(nextStatus.status === 'disconnected' ? [] : await getCalendarConflicts());
      setMessage('');
    } catch {
      setMessage(t('calendar.error'));
    }
  };

  useEffect(() => { void refresh(); }, []);

  const sync = async () => {
    try {
      await requestCalendarSync(operationId('web-calendar-sync'));
      setMessage(t('calendar.syncQueued'));
      await refresh();
    } catch { setMessage(t('calendar.error')); }
  };

  const resolve = async (conflict: CalendarConflictDto, strategy: 'eisenhower' | 'google') => {
    try {
      await resolveCalendarConflict(
        conflict._id, strategy, conflict.revision, operationId('web-calendar-resolve')
      );
      setConflicts((current) => current.filter((item) => item._id !== conflict._id));
      setMessage(t('calendar.conflictResolved'));
    } catch { setMessage(t('calendar.error')); }
  };

  return (
    <section aria-labelledby="calendar-sync-heading" className="mb-3 rounded-2xl border border-white/10 bg-white/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="calendar-sync-heading" className="font-semibold">{t('calendar.heading')}</h2>
          <p className="text-sm text-slate-300">
            {!status ? t('calendar.loading') : status.connection
              ? `Google Calendar: ${status.connection.calendarId}`
              : t('calendar.disconnected')}
          </p>
        </div>
        {status?.connection ? (
          <button type="button" onClick={() => void sync()} className="min-h-11 rounded-xl border border-cyan-200/30 px-3 py-2 text-sm font-semibold text-cyan-100 hover:bg-white/10">
            {t('calendar.syncNow')}
          </button>
        ) : null}
      </div>
      {message ? <p role="status" className="mt-2 text-sm text-amber-100">{message}</p> : null}
      {conflicts.length ? (
        <div className="mt-3 space-y-2">
          <h3 className="text-sm font-semibold">{t('calendar.conflicts')}</h3>
          {conflicts.map((conflict) => (
            <article key={conflict._id} className="rounded-xl border border-amber-200/20 bg-amber-300/5 p-3">
              <p className="font-medium">{conflict.providerSnapshot.title}</p>
              <p className="text-sm text-slate-300">{new Date(conflict.providerSnapshot.dueAt).toLocaleString()}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => void resolve(conflict, 'eisenhower')} className="min-h-11 rounded-lg border border-white/15 px-3 py-2 text-sm">{t('calendar.keepEisenhower')}</button>
                <button type="button" onClick={() => void resolve(conflict, 'google')} className="min-h-11 rounded-lg border border-white/15 px-3 py-2 text-sm">{t('calendar.useGoogle')}</button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
