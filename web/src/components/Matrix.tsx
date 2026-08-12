import { Suspense, useEffect, useRef, useState } from 'react';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import { Task, TaskInput } from '../types';
import { useLanguage } from '../i18n/LanguageContext';
import { shouldDisableMotion } from '../lib/motion';
import { restoreReadyState } from '../lib/uiState';
import { useMatrixController } from '../hooks/useMatrixController';
import { AIToolsComponent, MatrixSceneComponent } from './matrixLazyComponents';

interface Props {
  tasks: Task[];
  loading: boolean;
  onAddTask: (task: TaskInput, idempotencyKey?: string) => Promise<void>;
  onUpdateTask: (id: string, patch: Partial<TaskInput>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
}

export default function Matrix({ tasks, loading, onAddTask, onUpdateTask, onDeleteTask }: Props) {
  const { t } = useLanguage();
  const format = (template: string, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (current, [key, value]) => current.replace(`{${key}}`, value),
      template
    );
  const matrixRef = useRef<HTMLDivElement | null>(null);
  const [matrixIntroState, setMatrixIntroState] = useState<'pending' | 'ready'>(() =>
    shouldDisableMotion() ? 'ready' : 'pending'
  );
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<{
    id: string;
    title: string;
    description: string;
  } | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [taskErrors, setTaskErrors] = useState<Record<string, string>>({});
  const {
    aiError,
    aiLoading,
    closeAiTools,
    createError,
    createPending,
    handleAnalysisComplete,
    handleAnalysisImport,
    handleDragEnd,
    handleOCRImport,
    handleSubmit,
    handleSuggest,
    newTask,
    openAiTools,
    quadrants,
    showAiTools,
    updateNewTaskField,
  } = useMatrixController({
    tasks,
    onAddTask,
    onUpdateTask,
    translate: t,
  });

  const runTaskUpdate = async (id: string, patch: Partial<TaskInput>) => {
    setPendingTaskId(id);
    setTaskErrors((current) => ({ ...current, [id]: '' }));
    try {
      await onUpdateTask(id, patch);
      setEditingTask((current) => (current?.id === id ? null : current));
    } catch (issue) {
      setTaskErrors((current) => ({
        ...current,
        [id]: issue instanceof Error ? issue.message : t('status.saveError'),
      }));
    } finally {
      setPendingTaskId(null);
    }
  };

  const runTaskDelete = async (id: string) => {
    setPendingTaskId(id);
    setTaskErrors((current) => ({ ...current, [id]: '' }));
    try {
      await onDeleteTask(id);
      setPendingDeleteId(null);
    } catch (issue) {
      setTaskErrors((current) => ({
        ...current,
        [id]: issue instanceof Error ? issue.message : t('status.saveError'),
      }));
    } finally {
      setPendingTaskId(null);
    }
  };

  useEffect(() => {
    const root = matrixRef.current;

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
            ease: 'power3.out',
          },
          onComplete: () => {
            if (!cancelled) {
              setMatrixIntroState('ready');
            }
          },
        });

        intro
          .to(
            '[data-matrix-form]',
            {
              y: 0,
              autoAlpha: 1,
              duration: 0.78,
            },
            0.2
          )
          .to(
            '[data-matrix-section]',
            {
              y: 0,
              autoAlpha: 1,
              scale: 1,
              duration: 0.82,
              stagger: 0.08,
            },
            0.32
          );

        gsap.to('[data-matrix-float]', {
          y: -8,
          duration: 3.2,
          ease: 'sine.inOut',
          repeat: -1,
          yoyo: true,
          stagger: {
            each: 0.18,
            from: 'center',
          },
        });

        gsap.to('[data-matrix-beam]', {
          xPercent: 10,
          opacity: 0.28,
          duration: 4.8,
          ease: 'sine.inOut',
          repeat: -1,
          yoyo: true,
        });
      }, root);

      cleanup = () => {
        ctx.revert();
      };
    })().catch(() => {
      restoreReadyState(cancelled, () => setMatrixIntroState('ready'));
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  return (
    <div
      ref={matrixRef}
      data-matrix-intro={matrixIntroState}
      className="matrix-shell relative overflow-hidden rounded-[2rem] border border-white/10 bg-slate-900/82 p-4 shadow-[0_30px_100px_rgba(2,6,23,0.62)] backdrop-blur-xl sm:rounded-[2.5rem] sm:p-6"
    >
      <div aria-hidden="true" className="matrix-noise" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_18%,rgba(52,211,153,0.12),transparent_24%),radial-gradient(circle_at_82%_22%,rgba(103,232,249,0.14),transparent_26%),linear-gradient(180deg,rgba(15,23,42,0),rgba(2,6,23,0.64))]"
      />
      <div
        data-matrix-beam
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-10 top-14 h-px bg-linear-to-r from-transparent via-cyan-200/65 to-transparent opacity-[0.12]"
      />

      <Suspense
        fallback={
          <div className="absolute inset-0 bg-linear-to-br from-teal-500/20 to-cyan-500/10" />
        }
      >
        <MatrixSceneComponent />
      </Suspense>

      <div className="relative z-10 space-y-4 sm:space-y-6">
        <p className="text-sm leading-6 text-white/70">{t('matrix.help')}</p>
        <form
          data-matrix-form
          onSubmit={handleSubmit}
          className="relative grid gap-3 overflow-hidden rounded-4xl border border-white/10 bg-black/[0.28] p-4 backdrop-blur md:grid-cols-2"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0))]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -left-12 top-10 h-28 w-28 rounded-full bg-emerald-300/10 blur-3xl"
          />
          <label className="relative text-sm font-medium text-white/80">
            {t('form.title')}
            <input
              value={newTask.title}
              disabled={createPending}
              onChange={(event) => updateNewTaskField('title', event.target.value)}
              className="mt-1 min-h-12 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-white transition-all placeholder:text-white/50 focus:border-emerald-200/40 focus:bg-white/12 focus:outline-hidden"
              placeholder={t('form.title')}
              aria-label={t('form.title')}
            />
          </label>
          <label className="relative text-sm font-medium text-white/80">
            {t('form.description')}
            <input
              value={newTask.description}
              disabled={createPending}
              onChange={(event) => updateNewTaskField('description', event.target.value)}
              className="mt-1 min-h-12 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-white transition-all placeholder:text-white/50 focus:border-cyan-200/40 focus:bg-white/12 focus:outline-hidden"
              placeholder={t('form.description')}
              aria-label={t('form.description')}
            />
          </label>
          <label
            className={`flex cursor-pointer items-center justify-between rounded-2xl border px-4 py-3 transition-all ${
              newTask.urgent
                ? 'border-rose-300/35 bg-rose-500/12 shadow-lg shadow-rose-950/30 hover:border-rose-200/50 hover:bg-rose-500/18'
                : 'border-white/10 bg-white/5 hover:border-white/15 hover:bg-white/10'
            }`}
          >
            <input
              type="checkbox"
              disabled={createPending}
              checked={newTask.urgent}
              onChange={(event) => updateNewTaskField('urgent', event.target.checked)}
              className="sr-only"
            />
            <div className="flex items-center gap-3">
              <span
                className={`size-2.5 rounded-full transition-all ${
                  newTask.urgent
                    ? 'pulse-dot bg-rose-300 text-rose-300 shadow-lg shadow-rose-300/70'
                    : 'bg-white/30'
                }`}
              />
              <p className="text-sm font-semibold text-white">{t('form.urgent')}</p>
            </div>
            <span
              className={`relative inline-flex h-7 w-12 items-center rounded-full px-1 transition-all ${
                newTask.urgent ? 'bg-rose-300/85' : 'bg-white/10'
              }`}
            >
              <span
                className={`size-5 rounded-full bg-white shadow-lg transition-transform ${
                  newTask.urgent ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </span>
          </label>
          <label
            className={`flex cursor-pointer items-center justify-between rounded-2xl border px-4 py-3 transition-all ${
              newTask.important
                ? 'border-cyan-300/35 bg-cyan-500/12 shadow-lg shadow-cyan-950/30 hover:border-cyan-200/50 hover:bg-cyan-500/18'
                : 'border-white/10 bg-white/5 hover:border-white/15 hover:bg-white/10'
            }`}
          >
            <input
              type="checkbox"
              disabled={createPending}
              checked={newTask.important}
              onChange={(event) => updateNewTaskField('important', event.target.checked)}
              className="sr-only"
            />
            <div className="flex items-center gap-3">
              <span
                className={`size-2.5 rounded-full transition-all ${
                  newTask.important
                    ? 'pulse-dot bg-cyan-300 text-cyan-300 shadow-lg shadow-cyan-300/70'
                    : 'bg-white/30'
                }`}
              />
              <p className="text-sm font-semibold text-white">{t('form.important')}</p>
            </div>
            <span
              className={`relative inline-flex h-7 w-12 items-center rounded-full px-1 transition-all ${
                newTask.important ? 'bg-cyan-300/85' : 'bg-white/10'
              }`}
            >
              <span
                className={`size-5 rounded-full bg-white shadow-lg transition-transform ${
                  newTask.important ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </span>
          </label>
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <button
              type="submit"
              disabled={createPending}
              className="min-h-11 rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 transition-all hover:-translate-y-0.5 hover:bg-emerald-300 hover:shadow-lg hover:shadow-emerald-500/20 disabled:cursor-wait disabled:opacity-60"
            >
              {createPending ? t('task.saving') : t('form.submit')}
            </button>
            <button
              type="button"
              disabled={createPending || aiLoading}
              onClick={() => {
                void handleSuggest();
              }}
              className="rounded-full bg-white/10 px-4 py-2 text-sm text-white transition-all hover:bg-white/15 hover:text-white disabled:opacity-50"
            >
              {aiLoading ? t('ai.suggesting') : t('ai.suggest')}
            </button>
            <button
              type="button"
              onClick={openAiTools}
              disabled={createPending || !newTask.title.trim()}
              className={`rounded-full bg-white/10 px-4 py-2 text-sm text-white transition-all hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/10 ${
                newTask.title.trim() ? 'pulse-ai' : ''
              }`}
            >
              {t('ai.tools')}
            </button>
          </div>
          {aiError ? <p className="md:col-span-2 text-sm text-red-200">{aiError}</p> : null}
          {createError ? (
            <p role="alert" className="md:col-span-2 text-sm text-red-200">
              {createError}
            </p>
          ) : null}
        </form>

        <DragDropContext onDragEnd={(result) => void handleDragEnd(result)}>
          <div className="grid gap-4 lg:grid-cols-2">
            {quadrants.map((quadrant) => (
              <Droppable key={quadrant.key} droppableId={quadrant.key}>
                {(provided) => (
                  <section
                    data-matrix-section
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className="group relative min-h-56 overflow-hidden rounded-[1.9rem] border border-white/10 bg-white/6 p-4 transition-all duration-300 hover:-translate-y-1 hover:border-white/[0.14] hover:bg-white/[0.07]"
                  >
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-4 top-0 h-20 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0))] opacity-70 transition-opacity duration-300 group-hover:opacity-100"
                    />
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-semibold text-white">{quadrant.label}</h3>
                        <p className="text-xs text-white/55">
                          {quadrant.key === 'do'
                            ? t('matrix.doHint')
                            : quadrant.key === 'delegate'
                              ? t('matrix.delegateHint')
                              : quadrant.key === 'schedule'
                                ? t('matrix.scheduleHint')
                                : t('matrix.deleteHint')}
                        </p>
                      </div>
                      <span
                        data-matrix-float
                        className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-white/50"
                      >
                        {tasks.filter(quadrant.filter).length}
                      </span>
                    </div>
                    <div className="space-y-3">
                      {tasks.filter(quadrant.filter).map((task, index) => (
                        <Draggable key={task._id} draggableId={task._id} index={index}>
                          {(dragProvided) => (
                            <article
                              ref={dragProvided.innerRef}
                              {...dragProvided.draggableProps}
                              className="relative overflow-hidden rounded-[1.4rem] border border-white/10 bg-slate-950/72 p-4 text-white transition-all hover:border-white/16 hover:bg-slate-950/82 hover:shadow-[0_20px_50px_rgba(2,6,23,0.45)]"
                            >
                              <div
                                aria-hidden="true"
                                className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0))]"
                              />
                              <div className="flex items-start justify-between gap-3">
                                {editingTask?.id === task._id ? (
                                  <form
                                    className="min-w-0 flex-1 space-y-3"
                                    onSubmit={(event) => {
                                      event.preventDefault();
                                      if (!editingTask.title.trim()) return;
                                      void runTaskUpdate(task._id, {
                                        title: editingTask.title.trim(),
                                        description: editingTask.description.trim(),
                                      });
                                    }}
                                  >
                                    <label className="block text-xs font-medium text-white/70">
                                      {t('task.editTitle')}
                                      <input
                                        autoFocus
                                        aria-label={t('task.editTitle')}
                                        value={editingTask.title}
                                        onChange={(event) =>
                                          setEditingTask({
                                            ...editingTask,
                                            title: event.target.value,
                                          })
                                        }
                                        className="mt-1 min-h-11 w-full rounded-xl border border-white/20 bg-slate-900 px-3 py-2 text-white"
                                      />
                                    </label>
                                    <label className="block text-xs font-medium text-white/70">
                                      {t('task.editDescription')}
                                      <textarea
                                        aria-label={t('task.editDescription')}
                                        value={editingTask.description}
                                        onChange={(event) =>
                                          setEditingTask({
                                            ...editingTask,
                                            description: event.target.value,
                                          })
                                        }
                                        className="mt-1 min-h-20 w-full resize-y rounded-xl border border-white/20 bg-slate-900 px-3 py-2 text-white"
                                      />
                                    </label>
                                    <div className="flex flex-wrap gap-2">
                                      <button
                                        type="submit"
                                        disabled={
                                          pendingTaskId === task._id || !editingTask.title.trim()
                                        }
                                        className="min-h-11 rounded-xl bg-emerald-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-40"
                                      >
                                        {pendingTaskId === task._id
                                          ? t('task.saving')
                                          : t('task.saveEdit')}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setEditingTask(null)}
                                        className="min-h-11 rounded-xl bg-white/10 px-3 py-2 text-xs"
                                      >
                                        {t('task.cancelEdit')}
                                      </button>
                                    </div>
                                  </form>
                                ) : (
                                  <div className="min-w-0 flex-1">
                                    <h4 className="font-semibold">{task.title}</h4>
                                    {task.description ? (
                                      <p className="mt-1 text-sm text-white/70">
                                        {task.description}
                                      </p>
                                    ) : null}
                                  </div>
                                )}
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    {...dragProvided.dragHandleProps}
                                    aria-label={format(t('task.drag'), { title: task.title })}
                                    className="min-h-11 cursor-grab rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold text-white/70 transition-all hover:bg-white/15 hover:text-white active:cursor-grabbing"
                                  >
                                    ⋮⋮
                                  </button>
                                  {pendingDeleteId === task._id ? (
                                    <div
                                      role="group"
                                      aria-label={`${t('task.delete')} ${task.title}`}
                                      className="flex gap-1"
                                    >
                                      <button
                                        type="button"
                                        onClick={() => {
                                          void runTaskDelete(task._id);
                                        }}
                                        disabled={pendingTaskId === task._id}
                                        className="min-h-11 rounded-xl bg-red-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                                      >
                                        {t('task.confirmDelete')}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setPendingDeleteId(null)}
                                        className="min-h-11 rounded-xl bg-white/10 px-3 py-2 text-xs"
                                      >
                                        {t('task.cancelDelete')}
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      aria-label={`${t('task.delete')} ${task.title}`}
                                      onClick={() => setPendingDeleteId(task._id)}
                                      className="min-h-11 rounded-xl bg-red-500/20 px-3 py-2 text-xs font-semibold text-red-100 transition-all hover:bg-red-500/30 hover:text-white"
                                    >
                                      {t('task.delete')}
                                    </button>
                                  )}
                                </div>
                              </div>
                              {editingTask?.id !== task._id ? (
                                <button
                                  type="button"
                                  aria-label={format(t('task.edit'), { title: task.title })}
                                  onClick={() =>
                                    setEditingTask({
                                      id: task._id,
                                      title: task.title,
                                      description: task.description,
                                    })
                                  }
                                  className="mt-3 min-h-11 rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold hover:bg-white/15"
                                >
                                  {format(t('task.edit'), { title: task.title })}
                                </button>
                              ) : null}
                              {taskErrors[task._id] ? (
                                <p role="alert" className="mt-3 text-sm text-red-200">
                                  {taskErrors[task._id]}
                                </p>
                              ) : null}
                              <div className="mt-4 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  aria-label={format(t('task.toggleUrgent'), { title: task.title })}
                                  aria-pressed={task.urgent}
                                  onClick={() => {
                                    void runTaskUpdate(task._id, { urgent: !task.urgent });
                                  }}
                                  disabled={pendingTaskId === task._id}
                                  className={`min-h-11 rounded-xl px-3 py-2 text-xs transition-all disabled:opacity-40 ${
                                    task.urgent
                                      ? 'bg-rose-400 text-slate-950 hover:bg-rose-300'
                                      : 'bg-white/10 text-white hover:bg-white/15'
                                  }`}
                                >
                                  {t('form.urgent')}: {task.urgent ? t('state.on') : t('state.off')}
                                </button>
                                <button
                                  type="button"
                                  aria-label={format(t('task.toggleImportant'), {
                                    title: task.title,
                                  })}
                                  aria-pressed={task.important}
                                  onClick={() => {
                                    void runTaskUpdate(task._id, { important: !task.important });
                                  }}
                                  disabled={pendingTaskId === task._id}
                                  className={`min-h-11 rounded-xl px-3 py-2 text-xs transition-all disabled:opacity-40 ${
                                    task.important
                                      ? 'bg-cyan-300 text-slate-950 hover:bg-cyan-200'
                                      : 'bg-white/10 text-white hover:bg-white/15'
                                  }`}
                                >
                                  {t('form.important')}:{' '}
                                  {task.important ? t('state.on') : t('state.off')}
                                </button>
                              </div>
                            </article>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                      {!loading && tasks.filter(quadrant.filter).length === 0 ? (
                        <p className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-white/45">
                          {t('task.empty')}
                        </p>
                      ) : null}
                    </div>
                  </section>
                )}
              </Droppable>
            ))}
          </div>
        </DragDropContext>
      </div>

      {showAiTools ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 grid place-items-center bg-black/70 text-white">
              {t('ai.loading')}
            </div>
          }
        >
          <AIToolsComponent
            taskTitle={newTask.title}
            onClose={closeAiTools}
            onAnalysisComplete={handleAnalysisComplete}
            onAnalysisTaskAdd={handleAnalysisImport}
            onOCRTasksExtracted={handleOCRImport}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
