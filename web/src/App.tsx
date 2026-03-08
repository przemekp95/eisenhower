import { useEffect, useRef, useState } from 'react';
import Matrix from './components/Matrix';
import LanguageSwitcher from './components/LanguageSwitcher';
import useSmoothScroll from './hooks/useSmoothScroll';
import { LanguageProvider, useLanguage } from './i18n/LanguageContext';
import { shouldDisableMotion } from './lib/motion';
import { createTask, deleteTask, getTasks, updateTask } from './services/api';
import { Task, TaskInput } from './types';

function AppContent() {
  const { t } = useLanguage();
  const mainRef = useRef<HTMLElement | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useSmoothScroll();

  const loadTasks = async () => {
    setLoading(true);
    setError(null);
    try {
      const nextTasks = await getTasks();
      setTasks(nextTasks);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('status.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTasks();
  }, []);

  useEffect(() => {
    const root = mainRef.current;

    if (!root || shouldDisableMotion()) {
      return;
    }

    let cleanup = () => {};
    let cancelled = false;

    void (async () => {
      const { gsap } = await import('gsap');

      if (cancelled) {
        return;
      }

      const ctx = gsap.context(() => {
        const intro = gsap.timeline({
          defaults: {
            duration: 0.8,
            ease: 'power3.out',
          },
        });

        intro
          .from('[data-app-eyebrow]', { y: 18, autoAlpha: 0 })
          .from('[data-app-title]', { y: 28, autoAlpha: 0 }, '-=0.52')
          .from('[data-app-subtitle]', { y: 22, autoAlpha: 0 }, '-=0.5')
          .from('[data-app-actions]', { y: 18, autoAlpha: 0 }, '-=0.55')
          .from(
            '[data-app-matrix]',
            {
              y: 34,
              autoAlpha: 0,
              scale: 0.985,
              duration: 0.92,
            },
            '-=0.45'
          );
      }, root);

      cleanup = () => {
        ctx.revert();
      };
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  const handleAddTask = async (task: TaskInput) => {
    try {
      const created = await createTask(task);
      setTasks((current) => [created, ...current]);
      setError(null);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('status.saveError'));
    }
  };

  const handleUpdateTask = async (id: string, patch: Partial<TaskInput>) => {
    try {
      const updated = await updateTask(id, patch);
      setTasks((current) => current.map((task) => (task._id === id ? updated : task)));
      setError(null);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('status.saveError'));
    }
  };

  const handleDeleteTask = async (id: string) => {
    try {
      await deleteTask(id);
      setTasks((current) => current.filter((task) => task._id !== id));
      setError(null);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : t('status.saveError'));
    }
  };

  return (
    <main
      ref={mainRef}
      className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(13,148,136,0.35),rgba(15,23,42,1)_60%)] px-4 py-8 text-white"
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p
              data-app-eyebrow
              className="flex items-center gap-3 text-sm uppercase tracking-[0.35em] text-emerald-200/80"
            >
              <span
                aria-hidden="true"
                className="pulse-dot size-2 rounded-full bg-emerald-300 text-emerald-300"
              />
              {t('app.eyebrow')}
            </p>
            <h1 data-app-title className="mt-3 text-4xl font-semibold tracking-tight">
              {t('app.title')}
            </h1>
            <p data-app-subtitle className="mt-3 max-w-2xl text-base text-white/70">
              {t('app.subtitle')}
            </p>
          </div>
          <div data-app-actions className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => {
                void loadTasks();
              }}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm transition-all hover:border-white/20 hover:bg-white/10 hover:text-white"
            >
              {t('form.refresh')}
            </button>
            <LanguageSwitcher />
          </div>
        </div>

        {error ? (
          <div className="mb-4 rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        ) : null}

        {loading ? <p className="mb-4 text-sm text-white/70">{t('status.loading')}</p> : null}

        <div data-app-matrix>
          <Matrix
            tasks={tasks}
            loading={loading}
            onAddTask={handleAddTask}
            onUpdateTask={handleUpdateTask}
            onDeleteTask={handleDeleteTask}
          />
        </div>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}
