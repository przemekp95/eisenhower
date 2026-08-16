import { FormEvent, useMemo, useRef, useState } from 'react';
import { DropResult } from '@hello-pangea/dnd';
import { classifyTask, OCRResult } from '../services/api';
import { TranslationKey } from '../i18n/translations';
import { Task, TaskInput } from '../types';
import { quadrantToTaskState } from '../components/matrixUtils';

interface UseMatrixControllerOptions {
  tasks: Task[];
  onAddTask: (task: TaskInput, idempotencyKey?: string) => Promise<void>;
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
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createPendingRef = useRef(false);
  const createOperationKeyRef = useRef<string | null>(null);
  const ocrOperationKeysRef = useRef(new Map<string, string>());

  const newOperationKey = (source: string) =>
    `${source}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  const quadrants = useMemo(
    () => [
      {
        key: 'do',
        label: translate('matrix.do'),
        filter: (task: Task) => task.urgent && task.important,
      },
      {
        key: 'delegate',
        label: translate('matrix.delegate'),
        filter: (task: Task) => task.urgent && !task.important,
      },
      {
        key: 'schedule',
        label: translate('matrix.schedule'),
        filter: (task: Task) => !task.urgent && task.important,
      },
      {
        key: 'delete',
        label: translate('matrix.delete'),
        filter: (task: Task) => !task.urgent && !task.important,
      },
    ],
    [translate]
  );

  const resetNewTask = () => {
    setNewTask(EMPTY_TASK);
  };

  const updateNewTaskField = <Key extends keyof TaskInput>(key: Key, value: TaskInput[Key]) => {
    createOperationKeyRef.current = null;
    setNewTask((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!newTask.title.trim() || createPendingRef.current) {
      return;
    }

    createPendingRef.current = true;
    setCreatePending(true);
    setCreateError(null);
    const operationKey =
      createOperationKeyRef.current ??
      `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    createOperationKeyRef.current = operationKey;
    try {
      await onAddTask(
        {
          ...newTask,
          title: newTask.title.trim(),
          description: newTask.description.trim(),
        },
        operationKey
      );
      createOperationKeyRef.current = null;
      resetNewTask();
    } catch {
      setCreateError(translate('status.createError'));
    } finally {
      createPendingRef.current = false;
      setCreatePending(false);
    }
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
    } catch {
      setAiError(translate('ai.analysis.failed'));
    } finally {
      setAiLoading(false);
    }
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

    const persistedTasks: Array<{ text: string; quadrant: number }> = [];
    let failed = 0;

    for (const detectedTask of importedTasks) {
      const operation = `${detectedTask.text}\u0000${detectedTask.quadrant}`;
      const idempotencyKey =
        ocrOperationKeysRef.current.get(operation) ?? newOperationKey('web-ocr-import');
      ocrOperationKeysRef.current.set(operation, idempotencyKey);
      try {
        await onAddTask(
          {
            title: detectedTask.text,
            description: '',
            ...quadrantToTaskState(detectedTask.quadrant),
          },
          idempotencyKey
        );
        ocrOperationKeysRef.current.delete(operation);
        persistedTasks.push(detectedTask);
      } catch {
        failed += 1;
      }
    }

    return { imported: persistedTasks.length, failed };
  };

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination || result.destination.droppableId === result.source.droppableId) {
      return;
    }

    const nextState = quadrantToTaskState(
      ['do', 'delegate', 'schedule', 'delete'].indexOf(result.destination.droppableId)
    );
    await onUpdateTask(result.draggableId, nextState);
  };

  return {
    aiError,
    aiLoading,
    createError,
    createPending,
    handleDragEnd,
    handleOCRImport,
    handleSubmit,
    handleSuggest,
    newTask,
    quadrants,
    updateNewTaskField,
  };
}
