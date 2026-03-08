import { lazy, Suspense, useMemo, useState } from 'react';
import { DragDropContext, Draggable, Droppable, DropResult } from '@hello-pangea/dnd';
import { classifyTask, LangChainAnalysis } from '../services/api';
import { Task, TaskInput } from '../types';
import { useLanguage } from '../i18n/LanguageContext';
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

  const onDragEnd = async (result: DropResult) => {
    if (!result.destination || result.destination.droppableId === result.source.droppableId) {
      return;
    }

    const nextState = quadrantToTaskState(
      ['do', 'schedule', 'delegate', 'delete'].indexOf(result.destination.droppableId)
    );
    await onUpdateTask(result.draggableId, nextState);
  };

  return (
    <div className="relative overflow-hidden rounded-4xl border border-white/10 bg-slate-900/80 p-6 shadow-2xl">
      <Suspense fallback={<div className="absolute inset-0 bg-linear-to-br from-teal-500/20 to-cyan-500/10" />}>
        <LazyMatrixScene />
      </Suspense>

      <div className="relative z-10 space-y-6">
        <form onSubmit={handleSubmit} className="grid gap-3 rounded-3xl border border-white/10 bg-black/25 p-4 md:grid-cols-2">
          <input
            value={newTask.title}
            onChange={(event) => setNewTask((current) => ({ ...current, title: event.target.value }))}
            className="rounded-full border border-white/10 bg-white/10 px-4 py-3 text-white placeholder:text-white/50"
            placeholder={t('form.title')}
          />
          <input
            value={newTask.description}
            onChange={(event) => setNewTask((current) => ({ ...current, description: event.target.value }))}
            className="rounded-full border border-white/10 bg-white/10 px-4 py-3 text-white placeholder:text-white/50"
            placeholder={t('form.description')}
          />
          <label className="flex items-center gap-2 text-sm text-white">
            <input
              type="checkbox"
              checked={newTask.urgent}
              onChange={(event) => setNewTask((current) => ({ ...current, urgent: event.target.checked }))}
            />
            {t('form.urgent')}
          </label>
          <label className="flex items-center gap-2 text-sm text-white">
            <input
              type="checkbox"
              checked={newTask.important}
              onChange={(event) => setNewTask((current) => ({ ...current, important: event.target.checked }))}
            />
            {t('form.important')}
          </label>
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <button type="submit" className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950">
              {t('form.submit')}
            </button>
            <button
              type="button"
              onClick={() => {
                void handleSuggest();
              }}
              className="rounded-full bg-white/10 px-4 py-2 text-sm text-white"
            >
              {aiLoading ? t('ai.suggesting') : t('ai.suggest')}
            </button>
            <button
              type="button"
              onClick={() => setShowAiTools(true)}
              disabled={!newTask.title.trim()}
              className="rounded-full bg-white/10 px-4 py-2 text-sm text-white disabled:opacity-40"
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
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className="min-h-56 rounded-3xl border border-white/10 bg-white/5 p-4"
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-lg font-semibold text-white">{quadrant.label}</h3>
                      <span className="text-xs uppercase tracking-[0.2em] text-white/50">
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
                              className="rounded-[1.25rem] border border-white/10 bg-slate-950/70 p-4 text-white"
                            >
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
                                  className="rounded-full bg-red-500/20 px-3 py-1 text-xs font-semibold text-red-100"
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
                                  className={`rounded-full px-3 py-1 text-xs ${task.urgent ? 'bg-rose-400 text-slate-950' : 'bg-white/10 text-white'}`}
                                >
                                  {t('form.urgent')}: {task.urgent ? 'on' : 'off'}
                                </button>
                                <button
                                  type="button"
                                  aria-label={`toggle important ${task.title}`}
                                  onClick={() => {
                                    void onUpdateTask(task._id, { important: !task.important });
                                  }}
                                  className={`rounded-full px-3 py-1 text-xs ${task.important ? 'bg-cyan-300 text-slate-950' : 'bg-white/10 text-white'}`}
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
          />
        </Suspense>
      ) : null}
    </div>
  );
}
