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
  createClientOperationId,
  getTaskRemoteId,
  hasPendingTasks,
  markTaskPendingDelete,
  markTaskSyncFailed,
  markTaskPendingUpdate,
  normalizeStoredTasks,
  reconcilePendingTasks,
  removeTask,
  resolveTaskConflict,
  runSingleFlight,
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
  const syncInFlightRef = useRef(null);

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
      tasksRef.current = normalizedCachedTasks;
      setTasks(normalizedCachedTasks);
      setLoading(false);

      const [remoteTasksResult, capabilitiesResult] = await Promise.allSettled([
        runSingleFlight(syncInFlightRef, async () => {
          const remoteTasks = normalizeStoredTasks(await fetchRemoteTasks(nextLanguage), nextLanguage);
          const resolvedTasks = await reconcilePendingTasks({
            cachedTasks: normalizedCachedTasks,
            remoteTasks,
            language: nextLanguage,
            createRemoteTask,
            updateRemoteTask,
            deleteRemoteTask,
          });
          await saveTasks(resolvedTasks);
          return { resolvedTasks, success: !hasPendingTasks(resolvedTasks) };
        }),
        fetchAICapabilities(),
      ]);

      if (!active) {
        return;
      }

      if (remoteTasksResult.status === 'fulfilled') {
        const { resolvedTasks } = remoteTasksResult.value;

        if (!active) {
          return;
        }

        tasksRef.current = resolvedTasks;
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
    tasksRef.current = normalizedTasks;
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

  const importScannedTasks = async (scannedTasks, { learn = false } = {}) => {
    const pendingTasks = scannedTasks.map((task) => {
      const clientOperationId = task.clientOperationId || createClientOperationId();
      return createTaskRecord(
        language,
        { ...task, clientOperationId },
        `local-scan-${clientOperationId}`,
      );
    });
    await persistTasks(mergeTasks(tasksRef.current, pendingTasks), t.pendingSyncNotice);

    const createdTasks = await Promise.all(
      pendingTasks.map(async (task) => {
        try {
          return {
            localTask: task,
            task: await createRemoteTask(
              taskToRemotePayload(task),
              language,
              task.clientOperationId,
            ),
            savedRemotely: true,
          };
        } catch (error) {
          return { localTask: task, task: markTaskSyncFailed(task, error), savedRemotely: false };
        }
      })
    );
    const importedTasks = createdTasks.map((entry) => entry.task);
    const remotelySavedTasks = createdTasks
      .filter((entry) => entry.savedRemotely)
      .map((entry) => entry.task);
    let feedbackSaved = false;

    if (learn && remotelySavedTasks.length > 0) {
      try {
        await learnFromAcceptedOCRTasks(remotelySavedTasks);
        feedbackSaved = true;
      } catch {
        feedbackSaved = false;
      }
    }

    const withoutPendingCreates = createdTasks.reduce(
      (current, entry) => removeTask(current, entry.localTask),
      tasksRef.current,
    );
    const finalTasks = mergeTasks(withoutPendingCreates, importedTasks);
    await persistTasks(
      finalTasks,
      hasPendingTasks(finalTasks) ? t.pendingSyncNotice : t.syncedRemote
    );
    return {
      requested: scannedTasks.length,
      imported: importedTasks.length,
      savedRemotely: remotelySavedTasks.length,
      pending: importedTasks.length - remotelySavedTasks.length,
      feedbackSaved,
    };
  };

  const retrySync = (cachedTasksOverride = null) => {
    const cachedTasks = Array.isArray(cachedTasksOverride)
      ? cachedTasksOverride
      : tasksRef.current;
    setNotice(t.syncing);

    return runSingleFlight(syncInFlightRef, async () => {
      try {
        const remoteTasks = normalizeStoredTasks(await fetchRemoteTasks(language), language);
        const resolvedTasks = await reconcilePendingTasks({
          cachedTasks,
          remoteTasks,
          language,
          createRemoteTask,
          updateRemoteTask,
          deleteRemoteTask,
        });
        await persistTasks(
          resolvedTasks,
          hasPendingTasks(resolvedTasks) ? t.pendingSyncNotice : t.syncedRemote
        );
        return { resolvedTasks, success: !hasPendingTasks(resolvedTasks) };
      } catch {
        setNotice(hasPendingTasks(cachedTasks) ? t.pendingSyncNotice : t.syncFailed);
        return { resolvedTasks: cachedTasks, success: false };
      }
    }).then((result) => result.success);
  };

  const handleResolveConflict = async (id, resolution) => {
    const conflictTask = tasksRef.current.find((task) => task.id === id);
    if (!conflictTask || conflictTask.syncState !== TASK_SYNC_STATE.conflict) {
      return;
    }

    const resolvedTask = resolveTaskConflict(conflictTask, resolution);
    const nextTasks = resolvedTask
      ? upsertTask(tasksRef.current, resolvedTask)
      : removeTask(tasksRef.current, conflictTask);

    if (resolution === 'remote') {
      await persistTasks(nextTasks, hasPendingTasks(nextTasks) ? t.pendingSyncNotice : t.syncedRemote);
      return;
    }

    await persistTasks(nextTasks, t.pendingSyncNotice);
    await retrySync(nextTasks);
  };

  const addAnalysisTaskToMatrix = async (analysis) => {
    const quadrant = getSuggestedQuadrant(analysis);
    const clientOperationId = createClientOperationId();
    const taskRecord = createTaskRecord(
      language,
      {
        title: analysis.task,
        description: analysis.langchain_analysis?.reasoning || '',
        ...quadrantToFlags(quadrant),
        clientOperationId,
      },
      `analysis-${clientOperationId}`
    );
    await persistTasks([taskRecord, ...tasksRef.current], t.pendingSyncNotice);

    try {
      const remoteTask = await createRemoteTask(
        taskToRemotePayload(taskRecord),
        language,
        clientOperationId,
      );
      await persistTasks(
        upsertTask(removeTask(tasksRef.current, taskRecord), remoteTask),
        t.syncedRemote,
      );
    } catch (error) {
      await persistTasks(
        upsertTask(tasksRef.current, markTaskSyncFailed(taskRecord, error)),
        t.cachedLocal,
      );
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

    const clientOperationId = createClientOperationId();
    const localTask = createTaskRecord(
      language,
      { ...newTask, clientOperationId },
      `local-${clientOperationId}`,
    );
    await persistTasks([localTask, ...tasksRef.current], t.pendingSyncNotice);

    try {
      const remoteTask = await createRemoteTask(
        taskToRemotePayload(localTask),
        language,
        clientOperationId,
      );
      await persistTasks(
        upsertTask(removeTask(tasksRef.current, localTask), remoteTask),
        t.syncedRemote,
      );
    } catch (error) {
      await persistTasks(
        upsertTask(tasksRef.current, markTaskSyncFailed(localTask, error)),
        t.cachedLocal,
      );
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
      await deleteRemoteTask(remoteId, currentTask.revision);
      await persistTasks(removeTask(tasksRef.current, currentTask), t.syncedRemote);
    } catch (error) {
      const pendingDeleteTask = markTaskPendingDelete(currentTask);
      const nextTasks = pendingDeleteTask
        ? upsertTask(removeTask(tasksRef.current, currentTask), pendingDeleteTask)
        : removeTask(tasksRef.current, currentTask);
      await persistTasks(nextTasks, t.pendingSyncNotice);
      const status = Number(error?.status || error?.response?.status || 0);
      if (status === 409 || status === 412 || status === 428) {
        await retrySync(nextTasks);
      }
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
      const remoteTask = await updateRemoteTask(
        remoteId,
        { [key]: nextTask[key] },
        language,
        toggledTask.revision,
      );
      await persistTasks(upsertTask(tasksRef.current, remoteTask), t.syncedRemote);
    } catch (error) {
      const status = Number(error?.status || error?.response?.status || 0);
      if (status === 409 || status === 412 || status === 428) {
        await persistTasks(nextTasks, t.pendingSyncNotice);
        await retrySync(nextTasks);
      } else {
        await persistTasks(upsertTask(tasksRef.current, markTaskSyncFailed(localTask, error)), t.pendingSyncNotice);
      }
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
    handleResolveConflict,
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
    retrySync,
    scanDisabled,
    suggestDisabled,
    t,
    updateNewTaskField,
  };
}
