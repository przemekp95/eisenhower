import { FormEvent, useMemo, useState } from 'react';
import { DropResult } from '@hello-pangea/dnd';
import { classifyTask, LangChainAnalysis, learnFromAcceptedOCRTasks, OCRResult } from '../services/api';
import { TranslationKey } from '../i18n/translations';
import { Task, TaskInput } from '../types';
import { quadrantToTaskState, resolveSuggestedQuadrant } from '../components/matrixUtils';

interface UseMatrixControllerOptions {
  tasks: Task[];
  onAddTask: (task: TaskInput) => Promise<void>;
  onUpdateTask: (id: string, patch: Partial<TaskInput>) => Promise<void>;
  translate: (key: TranslationKey) => string;
}

const EMPTY_TASK: TaskInput = {
  title: '',
  description: '',
  urgent: false,
  important: false,
};

export function useMatrixController({
  tasks,
  onAddTask,
  onUpdateTask,
  translate,
}: UseMatrixControllerOptions) {
  const [newTask, setNewTask] = useState<TaskInput>(EMPTY_TASK);
  const [showAiTools, setShowAiTools] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const quadrants = useMemo(
    () => [
      { key: 'do', label: translate('matrix.do'), filter: (task: Task) => task.urgent && task.important },
      { key: 'schedule', label: translate('matrix.schedule'), filter: (task: Task) => task.urgent && !task.important },
      { key: 'delegate', label: translate('matrix.delegate'), filter: (task: Task) => !task.urgent && task.important },
      { key: 'delete', label: translate('matrix.delete'), filter: (task: Task) => !task.urgent && !task.important },
    ],
    [translate]
  );

  const resetNewTask = () => {
    setNewTask(EMPTY_TASK);
  };

  const updateNewTaskField = <Key extends keyof TaskInput>(key: Key, value: TaskInput[Key]) => {
    setNewTask((current) => ({ ...current, [key]: value }));
  };

  const openAiTools = () => {
    setShowAiTools(true);
  };

  const closeAiTools = () => {
    setShowAiTools(false);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!newTask.title.trim()) {
      return;
    }

    await onAddTask({
      ...newTask,
      title: newTask.title.trim(),
      description: newTask.description.trim(),
    });
    resetNewTask();
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

    resetNewTask();
    closeAiTools();
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

    void learnFromAcceptedOCRTasks(importedTasks).catch(() => undefined);

    return importedTasks.length;
  };

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination || result.destination.droppableId === result.source.droppableId) {
      return;
    }

    const nextState = quadrantToTaskState(
      ['do', 'schedule', 'delegate', 'delete'].indexOf(result.destination.droppableId)
    );
    await onUpdateTask(result.draggableId, nextState);
  };

  return {
    aiError,
    aiLoading,
    closeAiTools,
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
  };
}
