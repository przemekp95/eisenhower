import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CalendarConflictDto,
  CalendarDeletedBindingDto,
  CalendarStatusDto,
} from '@eisenhower/api-client';
import {
  disconnectCalendar,
  getCalendarDeletedBindings,
  getCalendarConflicts,
  getCalendarStatus,
  requestCalendarSync,
  resolveCalendarConflict,
  resolveCalendarDeletedBinding,
  startCalendarConnection,
} from '../services/api';
import { useLanguage } from '../i18n/LanguageContext';
import CalendarEventManager from './CalendarEventManager';

function operationId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function safeGoogleAuthorizationUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'accounts.google.com' ||
    !url.pathname.startsWith('/o/oauth2/')
  ) {
    throw new Error('unsafe_calendar_authorization_url');
  }
  return url.toString();
}

interface Props {
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  navigate?: (url: string) => void;
}

export const DEFAULT_CALENDAR_POLL_INTERVAL_MS = 1_500;
export const DEFAULT_CALENDAR_MAX_POLL_ATTEMPTS = 30;

export default function CalendarSyncPanel({
  pollIntervalMs = DEFAULT_CALENDAR_POLL_INTERVAL_MS,
  maxPollAttempts = DEFAULT_CALENDAR_MAX_POLL_ATTEMPTS,
  navigate = (url) => void window.open(url, '_self'),
}: Props) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<CalendarStatusDto | null>(null);
  const [conflicts, setConflicts] = useState<CalendarConflictDto[]>([]);
  const [deletedBindings, setDeletedBindings] = useState<CalendarDeletedBindingDto[]>([]);
  const [message, setMessage] = useState('');
  const [busyAction, setBusyAction] = useState<'connect' | 'disconnect' | 'sync' | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [pollExhausted, setPollExhausted] = useState(false);
  const [pollGeneration, setPollGeneration] = useState(0);
  const syncKey = useRef<string | null>(null);
  const conflictKeys = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const pollAttempts = useRef(0);

  const refresh = useCallback(async () => {
    const nextStatus = await getCalendarStatus();
    const [nextConflicts, nextDeletedBindings] =
      nextStatus.status === 'disconnected'
        ? [[], []]
        : await Promise.all([getCalendarConflicts(), getCalendarDeletedBindings()]);
    if (mounted.current) {
      setStatus(nextStatus);
      setConflicts(nextConflicts);
      setDeletedBindings(nextDeletedBindings);
    }
    return nextStatus;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => setMessage(t('calendar.error')));
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const inProgress =
    status?.syncProblem !== true &&
    (status?.status === 'pending' ||
      (status?.pendingOutbox !== undefined && status.pendingOutbox > 0));
  const hasSyncProblem = status?.syncProblem === true;

  useEffect(() => {
    if (!inProgress) {
      pollAttempts.current = 0;
      setPollExhausted(false);
      if (status?.status === 'connected') syncKey.current = null;
      return;
    }
    if (pollAttempts.current >= maxPollAttempts) {
      setMessage(t('calendar.stillWorking'));
      setPollExhausted(true);
      return;
    }

    const timer = window.setTimeout(() => {
      pollAttempts.current += 1;
      void refresh()
        .catch(() => setMessage(t('calendar.error')))
        .finally(() => {
          if (mounted.current) setPollGeneration((generation) => generation + 1);
        });
    }, pollIntervalMs);
    return () => window.clearTimeout(timer);
  }, [inProgress, maxPollAttempts, pollGeneration, pollIntervalMs, refresh, status?.status, t]);

  const resumePolling = () => {
    pollAttempts.current = 0;
    setPollExhausted(false);
    setMessage(t('calendar.inProgress'));
    setPollGeneration((generation) => generation + 1);
  };

  const connect = async () => {
    setBusyAction('connect');
    setMessage('');
    try {
      const returnPath = `${window.location.pathname}${window.location.search}`;
      const result = await startCalendarConnection(returnPath);
      navigate(safeGoogleAuthorizationUrl(result.authorizationUrl));
    } catch (issue) {
      const statusCode = (issue as { status?: number })?.status;
      setMessage(statusCode === 404 ? t('calendar.unavailable') : t('calendar.error'));
      setBusyAction(null);
    }
  };

  const disconnect = async () => {
    setBusyAction('disconnect');
    setMessage('');
    try {
      await disconnectCalendar();
      setConfirmDisconnect(false);
      await refresh();
      setMessage(t('calendar.disconnectedSuccess'));
    } catch {
      setMessage(t('calendar.error'));
    } finally {
      setBusyAction(null);
    }
  };

  const sync = async () => {
    pollAttempts.current = 0;
    setPollExhausted(false);
    setBusyAction('sync');
    setMessage(t('calendar.syncing'));
    syncKey.current ??= operationId('web-calendar-sync');
    try {
      await requestCalendarSync(syncKey.current);
      const nextStatus = await refresh();
      if (
        nextStatus.status === 'connected' &&
        nextStatus.syncProblem !== true &&
        (nextStatus.pendingOutbox ?? 0) === 0
      ) {
        syncKey.current = null;
        setMessage(t('calendar.upToDate'));
      }
    } catch {
      setMessage(t('calendar.error'));
    } finally {
      setBusyAction(null);
    }
  };

  const retryFailedSync = () => {
    syncKey.current = operationId('web-calendar-sync-retry');
    void sync();
  };

  const resolve = async (conflict: CalendarConflictDto, strategy: 'eisenhower' | 'google') => {
    const key = `${conflict._id}:${strategy}`;
    const idempotencyKey = conflictKeys.current.get(key) ?? operationId('web-calendar-resolve');
    conflictKeys.current.set(key, idempotencyKey);
    try {
      await resolveCalendarConflict(conflict._id, strategy, conflict.revision, idempotencyKey);
      conflictKeys.current.delete(key);
      setConflicts((current) => current.filter((item) => item._id !== conflict._id));
      setMessage(t('calendar.conflictResolved'));
    } catch {
      setMessage(t('calendar.error'));
    }
  };

  const resolveDeletion = async (
    binding: CalendarDeletedBindingDto,
    strategy: 'clear_date' | 'recreate' | 'detach'
  ) => {
    const key = `deleted:${binding._id}:${strategy}`;
    const idempotencyKey = conflictKeys.current.get(key) ?? operationId('web-calendar-deletion');
    conflictKeys.current.set(key, idempotencyKey);
    try {
      await resolveCalendarDeletedBinding(
        binding._id,
        strategy,
        binding.taskRevision,
        idempotencyKey
      );
      conflictKeys.current.delete(key);
      setDeletedBindings((current) => current.filter((item) => item._id !== binding._id));
      setMessage(t('calendar.deletionResolved'));
    } catch {
      setMessage(t('calendar.error'));
    }
  };

  const lastCompletedAt =
    typeof status?.syncState?.lastCompletedAt === 'string'
      ? new Date(status.syncState.lastCompletedAt)
      : null;

  return (
    <section aria-labelledby="calendar-sync-heading" className="mb-3 border-t border-white/10 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="calendar-sync-heading" className="font-semibold">
            {t('calendar.heading')}
          </h2>
          <p className="mt-1 text-sm text-slate-300">
            {!status
              ? t('calendar.loading')
              : status.status === 'disconnected'
                ? t('calendar.disconnected')
                : hasSyncProblem
                  ? t('calendar.syncProblem')
                  : inProgress
                    ? t('calendar.inProgress')
                    : (status.openConflicts ?? 0) > 0
                      ? t('calendar.needsDecision')
                      : t('calendar.upToDate')}
          </p>
          {lastCompletedAt && !Number.isNaN(lastCompletedAt.valueOf()) ? (
            <p className="mt-1 text-xs text-slate-400">
              {t('calendar.lastUpdated').replace('{date}', lastCompletedAt.toLocaleString())}
            </p>
          ) : null}
        </div>

        {status?.status === 'disconnected' && status.canConnect ? (
          <button
            type="button"
            onClick={() => void connect()}
            disabled={busyAction !== null}
            className="min-h-11 w-full rounded-xl bg-cyan-200 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-100 disabled:opacity-50 sm:w-auto"
          >
            {busyAction === 'connect' ? t('calendar.connecting') : t('calendar.connect')}
          </button>
        ) : status?.status === 'disconnected' ? (
          <p className="text-sm text-slate-400">{t('calendar.unavailable')}</p>
        ) : status?.connection ? (
          <div className="flex w-full flex-col gap-2 min-[360px]:flex-row sm:w-auto">
            <button
              type="button"
              onClick={hasSyncProblem ? retryFailedSync : () => void sync()}
              disabled={busyAction !== null || inProgress}
              className="min-h-11 rounded-xl border border-cyan-200/30 px-3 py-2 text-sm font-semibold text-cyan-100 hover:bg-white/10 disabled:opacity-50"
            >
              {busyAction === 'sync' || inProgress
                ? t('calendar.syncing')
                : hasSyncProblem
                  ? t('calendar.tryAgain')
                  : t('calendar.syncNow')}
            </button>
            {inProgress && pollExhausted ? (
              <button
                type="button"
                onClick={resumePolling}
                disabled={busyAction !== null}
                className="min-h-11 rounded-xl border border-cyan-200/30 px-3 py-2 text-sm font-semibold text-cyan-100 hover:bg-white/10 disabled:opacity-50"
              >
                {t('calendar.checkAgain')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setConfirmDisconnect(true)}
              disabled={busyAction !== null}
              className="min-h-11 rounded-xl px-3 py-2 text-sm text-slate-300 hover:bg-white/10 hover:text-white disabled:opacity-50"
            >
              {t('calendar.disconnect')}
            </button>
          </div>
        ) : null}
      </div>

      {confirmDisconnect ? (
        <div
          role="alertdialog"
          aria-labelledby="calendar-disconnect-title"
          className="mt-3 border-l-2 border-amber-200/60 pl-3"
        >
          <p id="calendar-disconnect-title" className="text-sm text-amber-50">
            {t('calendar.disconnectQuestion')}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void disconnect()}
              className="min-h-11 rounded-lg bg-amber-100 px-3 py-2 text-sm font-semibold text-slate-950"
            >
              {t('calendar.disconnectConfirm')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDisconnect(false)}
              className="min-h-11 rounded-lg px-3 py-2 text-sm hover:bg-white/10"
            >
              {t('calendar.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-amber-100">
          {message}
        </p>
      ) : null}

      {conflicts.length ? (
        <div className="mt-4 space-y-3">
          <h3 className="text-sm font-semibold">{t('calendar.conflicts')}</h3>
          {conflicts.map((conflict) => (
            <article key={conflict._id} className="border-l-2 border-amber-200/50 pl-3">
              <p className="break-words font-medium">{conflict.providerSnapshot.title}</p>
              <p className="text-sm text-slate-300">
                {new Date(conflict.providerSnapshot.dueAt).toLocaleString()}
              </p>
              <div className="mt-2 flex flex-col gap-2 min-[360px]:flex-row">
                <button
                  type="button"
                  onClick={() => void resolve(conflict, 'eisenhower')}
                  className="min-h-11 rounded-lg border border-white/15 px-3 py-2 text-sm"
                >
                  {t('calendar.keepEisenhower')}
                </button>
                <button
                  type="button"
                  onClick={() => void resolve(conflict, 'google')}
                  className="min-h-11 rounded-lg border border-white/15 px-3 py-2 text-sm"
                >
                  {t('calendar.useGoogle')}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {deletedBindings.length ? (
        <div className="mt-4 space-y-3">
          <h3 className="text-sm font-semibold">{t('calendar.googleDeleted')}</h3>
          {deletedBindings.map((binding) => (
            <article key={binding._id} className="border-l-2 border-amber-200/50 pl-3">
              <p className="break-words font-medium">{binding.taskTitle}</p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {(['clear_date', 'recreate', 'detach'] as const).map((strategy) => (
                  <button
                    key={strategy}
                    type="button"
                    onClick={() => void resolveDeletion(binding, strategy)}
                    className="min-h-11 rounded-lg border border-white/15 px-3 py-2 text-sm"
                  >
                    {t(`calendar.deletion.${strategy}`)}
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {status?.status === 'connected' ? <CalendarEventManager /> : null}
    </section>
  );
}
