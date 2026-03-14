import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAICapabilities,
  learnFromAcceptedOCRTasks,
  suggestTaskQuadrant,
} from '../services/ai';
import { scanTasksFromImage } from '../services/media';
import { loadLanguage, loadTasks, saveLanguage, saveTasks } from '../services/storage';
import {
  createRemoteTask,
  deleteRemoteTask,
  fetchRemoteTasks,
  updateRemoteTask,
} from '../services/tasks';
import { translations } from '../i18n/translations';
import {
  createTaskRecord,
  getSampleTasks,
  groupTasksByQuadrant,
  mergeTasks,
  quadrantToFlags,
} from '../utils/taskUtils';
import {
  getQuadrantOptions,
  getSuggestedQuadrant,
  resolveOCRNotice,
  resolveSuggestionNotice,
} from '../utils/aiUi';
import {
  TASK_SYNC_STATE,
  getTaskRemoteId,
  hasPendingTasks,
  markTaskPendingDelete,
  markTaskPendingUpdate,
  normalizeStoredTasks,
  reconcilePendingTasks,
  removeTask,
  taskToRemotePayload,
  upsertTask,
} from '../utils/taskSync';

const EMPTY_TASK = {
  title: '',
  description: '',
  urgent: false,
  important: false,
};

export default function useTaskSyncController() {
  const [language, setLanguage] = useState('pl');
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [aiCapabilities, setAiCapabilities] = useState(null);
  const [newTask, setNewTask] = useState(EMPTY_TASK);
  const tasksRef = useRef([]);

  const t = translations[language];
  const quadrantOptions = useMemo(() => getQuadrantOptions(t), [t]);
  const groupedTasks = useMemo(() => groupTasksByQuadrant(tasks), [tasks]);
  const providerControls = aiCapabilities?.provider_controls || {};
  const aiConnected = Boolean(aiCapabilities);
  const suggestDisabled = !providerControls.local_model?.active;
  const scanDisabled = !providerControls.tesseract?.active;

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      let nextLanguage = 'pl';
      let cachedTasks = getSampleTasks('pl');

      try {
        nextLanguage = await loadLanguage();
      } catch {
        nextLanguage = 'pl';
      }

      try {
        cachedTasks = await loadTasks(nextLanguage);
      } catch {
        cachedTasks = getSampleTasks(nextLanguage);
      }

      const normalizedCachedTasks = normalizeStoredTasks(cachedTasks, nextLanguage);

      if (!active) {
        return;
      }

      setLanguage(nextLanguage);
      setTasks(normalizedCachedTasks);
      setLoading(false);

      const [remoteTasksResult, capabilitiesResult] = await Promise.allSettled([
        fetchRemoteTasks(nextLanguage),
        fetchAICapabilities(),
      ]);

      if (!active) {
        return;
      }

      if (remoteTasksResult.status === 'fulfilled') {
        let resolvedTasks = normalizeStoredTasks(remoteTasksResult.value, nextLanguage);
        resolvedTasks = await reconcilePendingTasks({
          cachedTasks: normalizedCachedTasks,
          remoteTasks: resolvedTasks,
          language: nextLanguage,
          createRemoteTask,
          updateRemoteTask,
          deleteRemoteTask,
        });
        await saveTasks(resolvedTasks);

        if (!active) {
          return;
        }

        setTasks(resolvedTasks);
        setNotice(
          hasPendingTasks(resolvedTasks)
            ? translations[nextLanguage].pendingSyncNotice
            : translations[nextLanguage].syncedRemote
        );
      } else {
        setNotice(translations[nextLanguage].cachedLocal);
      }

      setAiCapabilities(capabilitiesResult.status === 'fulfilled' ? capabilitiesResult.value : null);
      setAiLoading(false);
    };

    void bootstrap().catch(() => {
      if (!active) {
        return;
      }

      setLanguage('pl');
      setTasks(getSampleTasks('pl'));
      setAiCapabilities(null);
      setLoading(false);
      setAiLoading(false);
    });

    return () => {
      active = false;
    };
  }, []);

  const persistTasks = async (nextTasks, nextNotice = '', languageOverride = language) => {
    const normalizedTasks = normalizeStoredTasks(nextTasks, languageOverride);
    setTasks(normalizedTasks);
    setNotice(nextNotice);
    await saveTasks(normalizedTasks);
  };

  const refreshCapabilities = async () => {
    const capabilities = await fetchAICapabilities();
    setAiCapabilities(capabilities);
    return capabilities;
  };

  const updateNewTaskField = (key, value) => {
    setNewTask((current) => ({ ...current, [key]: value }));
  };

  const importScannedTasks = async (scannedTasks) => {
    const createdTasks = await Promise.all(
      scannedTasks.map(async (task, index) => {
        try {
          return await createRemoteTask(taskToRemotePayload(task), language);
        } catch {
          return createTaskRecord(language, task, task.id || `local-scan-${Date.now()}-${index}`);
        }
      })
    );

    void learnFromAcceptedOCRTasks(createdTasks).catch(() => undefined);

    await persistTasks(mergeTasks(tasksRef.current, createdTasks), t.ocrAdded);
    return createdTasks.length;
  };

  const addAnalysisTaskToMatrix = async (analysis) => {
    const quadrant = getSuggestedQuadrant(analysis);
    const taskRecord = createTaskRecord(
      language,
      {
        title: analysis.task,
        description: analysis.langchain_analysis?.reasoning || '',
        ...quadrantToFlags(quadrant),
      },
      `analysis-${Date.now()}`
    );

    try {
      const remoteTask = await createRemoteTask(taskToRemotePayload(taskRecord), language);
      await persistTasks([remoteTask, ...tasksRef.current], t.syncedRemote);
    } catch {
      await persistTasks([taskRecord, ...tasksRef.current], t.cachedLocal);
    }
  };

  const handleLanguageChange = async (nextLanguage) => {
    setLanguage(nextLanguage);
    setNotice('');
    await saveLanguage(nextLanguage);
  };

  const handleAddTask = async () => {
    if (!newTask.title.trim()) {
      return;
    }

    const localTask = createTaskRecord(language, newTask, `local-${Date.now()}`);

    try {
      const remoteTask = await createRemoteTask(taskToRemotePayload(localTask), language);
      await persistTasks([remoteTask, ...tasksRef.current], t.syncedRemote);
    } catch {
      await persistTasks([localTask, ...tasksRef.current], t.cachedLocal);
    }

    setNewTask(EMPTY_TASK);
  };

  const handleSuggest = async () => {
    if (!newTask.title.trim()) {
      return;
    }

    try {
      const suggestion = await suggestTaskQuadrant(newTask.title);
      setNewTask((current) => ({
        ...current,
        urgent: suggestion.urgent,
        important: suggestion.important,
      }));
    } catch (error) {
      setNotice(resolveSuggestionNotice(error, t));
    }
  };

  const handleDelete = async (id) => {
    const currentTask = tasksRef.current.find((task) => task.id === id);

    if (!currentTask) {
      return;
    }

    const remoteId = getTaskRemoteId(currentTask);

    if (
      !remoteId ||
      currentTask.syncState === TASK_SYNC_STATE.pendingCreate ||
      currentTask.syncState === TASK_SYNC_STATE.localSeed
    ) {
      await persistTasks(removeTask(tasksRef.current, currentTask), t.cachedLocal);
      return;
    }

    try {
      await deleteRemoteTask(remoteId);
      await persistTasks(removeTask(tasksRef.current, currentTask), t.syncedRemote);
    } catch {
      const pendingDeleteTask = markTaskPendingDelete(currentTask);
      const nextTasks = pendingDeleteTask
        ? upsertTask(removeTask(tasksRef.current, currentTask), pendingDeleteTask)
        : removeTask(tasksRef.current, currentTask);
      await persistTasks(nextTasks, t.cachedLocal);
    }
  };

  const handleToggle = async (id, key) => {
    const toggledTask = tasksRef.current.find((task) => task.id === id);

    if (!toggledTask) {
      return;
    }

    const nextTask = { ...toggledTask, [key]: !toggledTask[key] };
    const localTask = markTaskPendingUpdate(toggledTask, { [key]: !toggledTask[key] });
    const nextTasks = upsertTask(tasksRef.current, localTask);
    const remoteId = getTaskRemoteId(toggledTask);

    if (!remoteId) {
      await persistTasks(nextTasks, t.cachedLocal);
      return;
    }

    try {
      const remoteTask = await updateRemoteTask(remoteId, { [key]: nextTask[key] }, language);
      await persistTasks(upsertTask(tasksRef.current, remoteTask), t.syncedRemote);
    } catch {
      await persistTasks(nextTasks, t.cachedLocal);
    }
  };

  const handleScan = async () => {
    try {
      const scanned = await scanTasksFromImage(language);
      if (scanned.length === 0) {
        setNotice(t.ocrEmpty);
        return;
      }

      await importScannedTasks(scanned);
    } catch (error) {
      setNotice(resolveOCRNotice(error, t));
    }
  };

  return {
    addAnalysisTaskToMatrix,
    aiCapabilities,
    aiConnected,
    aiLoading,
    groupedTasks,
    handleAddTask,
    handleDelete,
    handleLanguageChange,
    handleScan,
    handleSuggest,
    handleToggle,
    importScannedTasks,
    language,
    loading,
    newTask,
    notice,
    providerControls,
    quadrantOptions,
    refreshCapabilities,
    scanDisabled,
    suggestDisabled,
    t,
    updateNewTaskField,
  };
}
