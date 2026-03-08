import { useEffect, useState } from 'react';
import Matrix from './components/Matrix';
import LanguageSwitcher from './components/LanguageSwitcher';
import { LanguageProvider, useLanguage } from './i18n/LanguageContext';
import { createTask, deleteTask, getTasks, updateTask } from './services/api';
import { Task, TaskInput } from './types';

function AppContent() {
  const { t } = useLanguage();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(13,148,136,0.35),_rgba(15,23,42,1)_60%)] px-4 py-8 text-white">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.35em] text-emerald-200/80">{t('app.eyebrow')}</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight">{t('app.title')}</h1>
            <p className="mt-3 max-w-2xl text-base text-white/70">{t('app.subtitle')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => {
                void loadTasks();
              }}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm"
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

        <Matrix
          tasks={tasks}
          loading={loading}
          onAddTask={handleAddTask}
          onUpdateTask={handleUpdateTask}
          onDeleteTask={handleDeleteTask}
        />
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
