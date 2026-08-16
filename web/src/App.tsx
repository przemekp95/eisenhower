import { FormEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import LanguageSwitcher from './components/LanguageSwitcher';
import Matrix from './components/Matrix';
import CalendarSyncPanel from './components/CalendarSyncPanel';
import {
  clearTokens,
  getAccessRejection,
  getApiToken,
  setApiToken,
  subscribeToApiToken,
} from './authSession';
import { LanguageProvider, useLanguage } from './i18n/LanguageContext';
import type { TranslationKey } from './i18n/translations';
import { replaceTaskById } from './lib/uiState';
import { runtimeConfig } from './config';
import { beginOidcLogin, completeOidcLogin, type OidcRuntimeConfig } from './oidcSession';
import {
  createTask,
  deleteTask,
  getDelegatedTasks,
  getTasks,
  transitionTaskDelegation,
  transitionTaskLifecycle,
  updateTask,
  updateTaskDelegation,
  updateTaskSchedule,
} from './services/api';
import type {
  Task,
  TaskDelegationAssignment,
  TaskDelegationStatus,
  TaskInput,
  TaskLifecycleAction,
  TaskLifecycleFilter,
  TaskSchedule,
  TaskView,
} from './types';

type LoadState = 'loading' | 'ready' | 'offline' | 'error';
type RequestError = Error & { status?: number; code?: string };

function safeMessage(
  issue: unknown,
  kind: 'load' | 'save',
  translate: (key: TranslationKey) => string
) {
  const requestError = issue as RequestError;

  if (requestError?.status === 412) return translate('status.conflict');
  if (requestError?.status === 401) return translate('auth.rejected');
  if (requestError?.status === 403) return translate('status.forbidden');
  if (
    issue instanceof TypeError ||
    requestError?.status === 0 ||
    (typeof navigator !== 'undefined' && navigator.onLine === false)
  ) {
    return translate('status.offline');
  }

  return translate(kind === 'load' ? 'status.loadError' : 'status.saveError');
}

function oidcConfig(): OidcRuntimeConfig | null {
  if (!runtimeConfig.oidcIssuer || !runtimeConfig.oidcClientId || !runtimeConfig.oidcRedirectUri) {
    return null;
  }
  return {
    issuer: runtimeConfig.oidcIssuer,
    clientId: runtimeConfig.oidcClientId,
    redirectUri: runtimeConfig.oidcRedirectUri,
    scopes: runtimeConfig.oidcScopes,
  };
}

function CredentialGate({ oidcFailed }: { oidcFailed: boolean }) {
  const { t } = useLanguage();
  const [code, setCode] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const rejected = getAccessRejection() === 'rejected';
  const oidc = oidcConfig();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return;
    setApiToken(code);
    setCode('');
  };

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-white sm:grid sm:place-items-center">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-5 flex justify-end">
          <LanguageSwitcher />
        </div>
        <form
          onSubmit={submit}
          aria-describedby="access-code-help"
          className="rounded-3xl border border-white/10 bg-slate-900 p-6 shadow-2xl sm:p-8"
        >
          <p className="text-sm font-semibold text-emerald-300">{t('auth.welcome')}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t('app.title')}</h1>
          <p id="access-code-help" className="mt-3 text-sm leading-6 text-slate-300">
            {t('auth.help')}
          </p>
          {rejected || oidcFailed ? (
            <p
              role="alert"
              className="mt-4 rounded-xl border border-red-300/30 bg-red-950/50 p-3 text-sm text-red-100"
            >
              {t('auth.rejected')}
            </p>
          ) : null}
          {!oidc ? (
            <>
              <label htmlFor="access-code" className="mt-6 block text-sm font-medium">
                {t('auth.code')}
              </label>
              <input
                ref={inputRef}
                id="access-code"
                type="password"
                autoComplete="off"
                value={code}
                required
                onChange={(event) => setCode(event.target.value)}
                className="mt-2 min-h-12 w-full rounded-xl border border-white/20 bg-slate-950 px-4 py-3 outline-none focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/30"
              />
            </>
          ) : null}
          <button
            type="submit"
            disabled={!oidc && !code.trim()}
            onClick={oidc ? () => void beginOidcLogin(oidc) : undefined}
            className="mt-5 min-h-12 w-full rounded-xl bg-cyan-300 px-4 py-3 font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('auth.enter')}
          </button>
          <p className="mt-4 text-xs leading-5 text-slate-400">{t('auth.memoryOnly')}</p>
        </form>
      </div>
    </main>
  );
}

function AppContent() {
  const { t } = useLanguage();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState(() => new Date());
  const [lifecycleFilter, setLifecycleFilter] = useState<TaskLifecycleFilter>('active');
  const [taskView, setTaskView] = useState<TaskView>('owned');

  const loadTasks = async (
    filter: TaskLifecycleFilter = lifecycleFilter,
    view: TaskView = taskView
  ) => {
    setLoadState('loading');
    setLoadError('');
    try {
      const nextTasks =
        view === 'delegated' ? await getDelegatedTasks(filter) : await getTasks(filter);
      setTasks(nextTasks);
      setLastSyncedAt(new Date());
      setLoadState('ready');
    } catch (issue) {
      const message = safeMessage(issue, 'load', t);
      setLoadError(message);
      setLoadState(message === t('status.offline') ? 'offline' : 'error');
    }
  };

  useEffect(() => {
    void loadTasks(lifecycleFilter, taskView);
  }, [lifecycleFilter, taskView]);

  useEffect(() => {
    const offline = () => {
      setLoadState('offline');
      setLoadError(t('status.offline'));
    };
    const online = () => void loadTasks();
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [t]);

  const handleAddTask = async (task: TaskInput, idempotencyKey?: string) => {
    try {
      const created = await createTask(task, idempotencyKey);
      setTasks((current) => [created, ...current]);
      setLastSyncedAt(new Date());
    } catch (issue) {
      throw new Error(safeMessage(issue, 'save', t));
    }
  };

  const handleUpdateTask = async (id: string, patch: Partial<TaskInput>) => {
    try {
      const revision = tasks.find((task) => task._id === id)?.revision;
      const updated = await updateTask(id, patch, revision);
      setTasks((current) => replaceTaskById(current, id, updated));
      setLastSyncedAt(new Date());
    } catch (issue) {
      throw new Error(safeMessage(issue, 'save', t));
    }
  };

  const handleDeleteTask = async (id: string) => {
    try {
      const revision = tasks.find((task) => task._id === id)?.revision;
      await deleteTask(id, revision);
      setTasks((current) => current.filter((task) => task._id !== id));
      setLastSyncedAt(new Date());
    } catch (issue) {
      throw new Error(safeMessage(issue, 'save', t));
    }
  };

  const handleLifecycleTask = async (id: string, action: TaskLifecycleAction) => {
    try {
      const revision = tasks.find((task) => task._id === id)?.revision;
      const updated = await transitionTaskLifecycle(id, action, revision);
      setTasks((current) => {
        if (lifecycleFilter !== 'all' && updated.lifecycleState !== lifecycleFilter) {
          return current.filter((task) => task._id !== id);
        }
        return replaceTaskById(current, id, updated);
      });
      setLastSyncedAt(new Date());
    } catch (issue) {
      throw new Error(safeMessage(issue, 'save', t));
    }
  };

  const handleUpdateSchedule = async (id: string, schedule: TaskSchedule | null) => {
    try {
      const revision = tasks.find((task) => task._id === id)?.revision;
      const updated = await updateTaskSchedule(id, schedule, revision);
      setTasks((current) => replaceTaskById(current, id, updated));
      setLastSyncedAt(new Date());
    } catch (issue) {
      throw new Error(safeMessage(issue, 'save', t));
    }
  };

  const handleUpdateDelegation = async (
    id: string,
    delegation: TaskDelegationAssignment | null
  ) => {
    try {
      const revision = tasks.find((task) => task._id === id)?.revision;
      const updated = await updateTaskDelegation(id, delegation, revision);
      setTasks((current) => replaceTaskById(current, id, updated));
      setLastSyncedAt(new Date());
    } catch (issue) {
      throw new Error(safeMessage(issue, 'save', t));
    }
  };

  const handleDelegationStatus = async (id: string, status: TaskDelegationStatus) => {
    try {
      const revision = tasks.find((task) => task._id === id)?.revision;
      const updated = await transitionTaskDelegation(id, status, revision);
      setTasks((current) => replaceTaskById(current, id, updated));
      setLastSyncedAt(new Date());
    } catch (issue) {
      throw new Error(safeMessage(issue, 'save', t));
    }
  };

  return (
    <main
      data-app-intro="ready"
      className="min-h-screen bg-slate-950 px-3 py-3 text-white sm:px-6 sm:py-5"
    >
      <div className="mx-auto max-w-7xl">
        <header className="mb-3 border-b border-white/10 pb-3 sm:mb-4 sm:pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {t('app.title')}
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-slate-300">{t('app.instruction')}</p>
            </div>
            <nav aria-label={t('nav.account')} className="flex flex-wrap items-center gap-2">
              <LanguageSwitcher />
              <button
                type="button"
                onClick={() => clearTokens()}
                className="min-h-11 rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/10"
              >
                {t('auth.logout')}
              </button>
            </nav>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            {loadState === 'loading' ? (
              <p role="status" aria-live="polite" className="text-slate-300">
                {t('status.loading')}
              </p>
            ) : null}
            {loadState === 'ready' ? (
              <p
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 text-emerald-200"
              >
                <span aria-hidden="true" className="size-2 rounded-full bg-emerald-300" />
                {t('status.current')}
                <span className="text-slate-400">
                  · {lastSyncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </p>
            ) : null}
            {loadState === 'ready' ? (
              <button
                type="button"
                onClick={() => void loadTasks()}
                className="min-h-11 rounded-lg border border-white/15 px-3 py-2 font-semibold hover:bg-white/10"
              >
                {t('status.refresh')}
              </button>
            ) : null}
            {loadState === 'offline' || loadState === 'error' ? (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-3 rounded-xl border border-red-300/25 bg-red-950/40 px-3 py-2 text-red-100"
              >
                <span>{loadError}</span>
                <button
                  type="button"
                  onClick={() => void loadTasks()}
                  className="min-h-11 rounded-lg bg-white/10 px-3 py-2 font-semibold hover:bg-white/20"
                >
                  {t('status.retry')}
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <nav
          aria-label={t('taskView.label')}
          className="mb-3 flex w-fit gap-1 rounded-full border border-white/10 bg-white/5 p-1"
        >
          {(['owned', 'delegated'] as TaskView[]).map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={taskView === view}
              onClick={() => setTaskView(view)}
              className={`min-h-11 rounded-full px-4 py-2 text-sm ${
                taskView === view ? 'bg-white text-slate-950' : 'text-white/70 hover:text-white'
              }`}
            >
              {t(`taskView.${view}`)}
            </button>
          ))}
        </nav>

        <Matrix
          tasks={tasks}
          loading={loadState === 'loading'}
          onAddTask={handleAddTask}
          onUpdateTask={handleUpdateTask}
          onDeleteTask={handleDeleteTask}
          lifecycleFilter={lifecycleFilter}
          onLifecycleFilterChange={setLifecycleFilter}
          onLifecycleTask={handleLifecycleTask}
          onUpdateSchedule={handleUpdateSchedule}
          taskView={taskView}
          onUpdateDelegation={handleUpdateDelegation}
          onDelegationStatus={handleDelegationStatus}
        />
        <div className="mt-4">
          <CalendarSyncPanel />
        </div>
      </div>
    </main>
  );
}

function AppRouter() {
  const apiToken = useSyncExternalStore(subscribeToApiToken, getApiToken, getApiToken);
  const [callbackState, setCallbackState] = useState<'checking' | 'ready' | 'failed'>('checking');

  useEffect(() => {
    const oidc = oidcConfig();
    if (!oidc || !window.location.search.includes('code=')) {
      setCallbackState('ready');
      return;
    }
    void completeOidcLogin(new URL(window.location.href), oidc)
      .then(() => setCallbackState('ready'))
      .catch(() => setCallbackState('failed'));
  }, []);

  if (callbackState === 'checking') return <main aria-busy="true" />;
  return apiToken ? <AppContent /> : <CredentialGate oidcFailed={callbackState === 'failed'} />;
}

export default function App() {
  return (
    <LanguageProvider>
      <AppRouter />
    </LanguageProvider>
  );
}
