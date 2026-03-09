import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { DragDropContext, Draggable, Droppable, DropResult } from '@hello-pangea/dnd';
import { classifyTask, LangChainAnalysis, OCRResult } from '../services/api';
import { Task, TaskInput } from '../types';
import { useLanguage } from '../i18n/LanguageContext';
import { shouldDisableMotion } from '../lib/motion';
import { restoreReadyState } from '../lib/uiState';
import { quadrantToTaskState, resolveSuggestedQuadrant } from './matrixUtils';

const LazyAITools = lazy(() => import('./AITools'));
const LazyMatrixScene = lazy(() => import('./MatrixScene'));

interface Props {
  tasks: Task[];
  loading: boolean;
  onAddTask: (task: TaskInput) => Promise<void>;
  onUpdateTask: (id: string, patch: Partial<TaskInput>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
}

export default function Matrix({ tasks, loading, onAddTask, onUpdateTask, onDeleteTask }: Props) {
  const { t } = useLanguage();
  const matrixRef = useRef<HTMLDivElement | null>(null);
  const [matrixIntroState, setMatrixIntroState] = useState<'pending' | 'ready'>(() =>
    shouldDisableMotion() ? 'ready' : 'pending'
  );
  const [newTask, setNewTask] = useState<TaskInput>({
    title: '',
    description: '',
    urgent: false,
    important: false,
  });
  const [showAiTools, setShowAiTools] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const quadrants = useMemo(
    () => [
      { key: 'do', label: t('matrix.do'), filter: (task: Task) => task.urgent && task.important },
      { key: 'schedule', label: t('matrix.schedule'), filter: (task: Task) => task.urgent && !task.important },
      { key: 'delegate', label: t('matrix.delegate'), filter: (task: Task) => !task.urgent && task.important },
      { key: 'delete', label: t('matrix.delete'), filter: (task: Task) => !task.urgent && !task.important },
    ],
    [t]
  );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newTask.title.trim()) {
      return;
    }

    await onAddTask({
      ...newTask,
      title: newTask.title.trim(),
      description: newTask.description.trim(),
    });
    setNewTask({ title: '', description: '', urgent: false, important: false });
  };

  const handleSuggest = async () => {
    if (!newTask.title.trim()) {
      return;
    }

    setAiLoading(true);
    setAiError(null);
    try {
      const prediction = await classifyTask(newTask.title);
      setNewTask((current) => ({
        ...current,
        urgent: prediction.urgent,
        important: prediction.important,
      }));
    } catch (issue) {
      setAiError(issue instanceof Error ? issue.message : 'Suggestion failed');
    } finally {
      setAiLoading(false);
    }
  };

  const handleAnalysisComplete = (analysis: LangChainAnalysis) => {
    const suggestedQuadrant = resolveSuggestedQuadrant(analysis);
    setNewTask((current) => ({
      ...current,
      ...quadrantToTaskState(suggestedQuadrant),
    }));
  };

  const handleAnalysisImport = async (analysis: LangChainAnalysis) => {
    const title = newTask.title.trim() || analysis.task.trim();

    await onAddTask({
      title,
      description: newTask.description.trim(),
      ...quadrantToTaskState(resolveSuggestedQuadrant(analysis)),
    });

    setNewTask({ title: '', description: '', urgent: false, important: false });
    setShowAiTools(false);
  };

  const handleOCRImport = async (result: OCRResult) => {
    const importedTasks = result.classified_tasks.reduce<Array<{ text: string; quadrant: number }>>(
      (collection, detectedTask) => {
        const title = detectedTask.text.trim();

        if (!title) {
          return collection;
        }

        const duplicate = collection.some(
          (task) => task.text === title && task.quadrant === detectedTask.quadrant
        );

        if (duplicate) {
          return collection;
        }

        collection.push({
          text: title,
          quadrant: detectedTask.quadrant,
        });
        return collection;
      },
      []
    );

    for (const detectedTask of importedTasks) {
      await onAddTask({
        title: detectedTask.text,
        description: '',
        ...quadrantToTaskState(detectedTask.quadrant),
      });
    }

    return importedTasks.length;
  };

  const onDragEnd = async (result: DropResult) => {
    if (!result.destination || result.destination.droppableId === result.source.droppableId) {
      return;
    }

    const nextState = quadrantToTaskState(
      ['do', 'schedule', 'delegate', 'delete'].indexOf(result.destination.droppableId)
    );
    await onUpdateTask(result.draggableId, nextState);
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
          .to('[data-matrix-form]', {
            y: 0,
            autoAlpha: 1,
            duration: 0.78,
          }, 0.2)
          .to('[data-matrix-section]', {
            y: 0,
            autoAlpha: 1,
            scale: 1,
            duration: 0.82,
            stagger: 0.08,
          }, 0.32);

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
      className="matrix-shell relative overflow-hidden rounded-[2.5rem] border border-white/10 bg-slate-900/[0.82] p-6 shadow-[0_30px_100px_rgba(2,6,23,0.62)] backdrop-blur-xl"
    >
      <div aria-hidden="true" className="matrix-noise" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_18%,rgba(52,211,153,0.12),transparent_24%),radial-gradient(circle_at_82%_22%,rgba(103,232,249,0.14),transparent_26%),linear-gradient(180deg,rgba(15,23,42,0),rgba(2,6,23,0.64))]"
      />
      <div
        data-matrix-beam
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-10 top-14 h-px bg-gradient-to-r from-transparent via-cyan-200/[0.65] to-transparent opacity-[0.12]"
      />

      <Suspense fallback={<div className="absolute inset-0 bg-linear-to-br from-teal-500/20 to-cyan-500/10" />}>
        <LazyMatrixScene />
      </Suspense>

      <div className="relative z-10 space-y-6">
        <form
          data-matrix-form
          onSubmit={handleSubmit}
          className="relative grid gap-3 overflow-hidden rounded-[2rem] border border-white/10 bg-black/[0.28] p-4 backdrop-blur md:grid-cols-2"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0))]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -left-12 top-10 h-28 w-28 rounded-full bg-emerald-300/10 blur-3xl"
          />
          <input
            value={newTask.title}
            onChange={(event) => setNewTask((current) => ({ ...current, title: event.target.value }))}
            className="rounded-full border border-white/10 bg-white/10 px-4 py-3 text-white transition-all placeholder:text-white/50 focus:border-emerald-200/40 focus:bg-white/[0.12] focus:outline-hidden"
            placeholder={t('form.title')}
          />
          <input
            value={newTask.description}
            onChange={(event) => setNewTask((current) => ({ ...current, description: event.target.value }))}
            className="rounded-full border border-white/10 bg-white/10 px-4 py-3 text-white transition-all placeholder:text-white/50 focus:border-cyan-200/40 focus:bg-white/[0.12] focus:outline-hidden"
            placeholder={t('form.description')}
          />
          <label
            className={`flex cursor-pointer items-center justify-between rounded-2xl border px-4 py-3 transition-all ${
              newTask.urgent
                ? 'border-rose-300/35 bg-rose-500/12 shadow-lg shadow-rose-950/30 hover:border-rose-200/50 hover:bg-rose-500/18'
                : 'border-white/10 bg-white/5 hover:border-white/15 hover:bg-white/10'
            }`}
          >
            <input
              type="checkbox"
              checked={newTask.urgent}
              onChange={(event) => setNewTask((current) => ({ ...current, urgent: event.target.checked }))}
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
              checked={newTask.important}
              onChange={(event) => setNewTask((current) => ({ ...current, important: event.target.checked }))}
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
              className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 transition-all hover:-translate-y-0.5 hover:bg-emerald-300 hover:shadow-lg hover:shadow-emerald-500/20"
            >
              {t('form.submit')}
            </button>
            <button
              type="button"
              onClick={() => {
                void handleSuggest();
              }}
              className="rounded-full bg-white/10 px-4 py-2 text-sm text-white transition-all hover:bg-white/15 hover:text-white"
            >
              {aiLoading ? t('ai.suggesting') : t('ai.suggest')}
            </button>
            <button
              type="button"
              onClick={() => setShowAiTools(true)}
              disabled={!newTask.title.trim()}
              className={`rounded-full bg-white/10 px-4 py-2 text-sm text-white transition-all hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/10 ${
                newTask.title.trim() ? 'pulse-ai' : ''
              }`}
            >
              {t('ai.tools')}
            </button>
          </div>
          {aiError ? <p className="md:col-span-2 text-sm text-red-200">{aiError}</p> : null}
        </form>

        <DragDropContext onDragEnd={(result) => void onDragEnd(result)}>
          <div className="grid gap-4 lg:grid-cols-2">
            {quadrants.map((quadrant) => (
              <Droppable key={quadrant.key} droppableId={quadrant.key}>
                {(provided) => (
                  <section
                    data-matrix-section
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className="group relative min-h-56 overflow-hidden rounded-[1.9rem] border border-white/10 bg-white/[0.06] p-4 transition-all duration-300 hover:-translate-y-1 hover:border-white/[0.14] hover:bg-white/[0.07]"
                  >
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-4 top-0 h-20 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0))] opacity-70 transition-opacity duration-300 group-hover:opacity-100"
                    />
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-lg font-semibold text-white">{quadrant.label}</h3>
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
                              {...dragProvided.dragHandleProps}
                              className="relative cursor-grab overflow-hidden rounded-[1.4rem] border border-white/10 bg-slate-950/[0.72] p-4 text-white transition-all hover:border-white/[0.16] hover:bg-slate-950/[0.82] hover:shadow-[0_20px_50px_rgba(2,6,23,0.45)] active:cursor-grabbing"
                            >
                              <div
                                aria-hidden="true"
                                className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0))]"
                              />
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <h4 className="font-semibold">{task.title}</h4>
                                  <p className="mt-1 text-sm text-white/70">{task.description}</p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    void onDeleteTask(task._id);
                                  }}
                                  className="rounded-full bg-red-500/20 px-3 py-1 text-xs font-semibold text-red-100 transition-all hover:bg-red-500/30 hover:text-white"
                                >
                                  {t('task.delete')}
                                </button>
                              </div>
                              <div className="mt-4 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  aria-label={`toggle urgent ${task.title}`}
                                  onClick={() => {
                                    void onUpdateTask(task._id, { urgent: !task.urgent });
                                  }}
                                  className={`rounded-full px-3 py-1 text-xs transition-all hover:-translate-y-0.5 ${
                                    task.urgent
                                      ? 'bg-rose-400 text-slate-950 hover:bg-rose-300'
                                      : 'bg-white/10 text-white hover:bg-white/15'
                                  }`}
                                >
                                  {t('form.urgent')}: {task.urgent ? 'on' : 'off'}
                                </button>
                                <button
                                  type="button"
                                  aria-label={`toggle important ${task.title}`}
                                  onClick={() => {
                                    void onUpdateTask(task._id, { important: !task.important });
                                  }}
                                  className={`rounded-full px-3 py-1 text-xs transition-all hover:-translate-y-0.5 ${
                                    task.important
                                      ? 'bg-cyan-300 text-slate-950 hover:bg-cyan-200'
                                      : 'bg-white/10 text-white hover:bg-white/15'
                                  }`}
                                >
                                  {t('form.important')}: {task.important ? 'on' : 'off'}
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
        <Suspense fallback={<div className="fixed inset-0 grid place-items-center bg-black/70 text-white">{t('ai.loading')}</div>}>
          <LazyAITools
            taskTitle={newTask.title}
            onClose={() => setShowAiTools(false)}
            onAnalysisComplete={handleAnalysisComplete}
            onAnalysisTaskAdd={handleAnalysisImport}
            onOCRTasksExtracted={handleOCRImport}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
