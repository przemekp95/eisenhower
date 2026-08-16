import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchAICapabilities, suggestTaskQuadrant } from '../services/ai';
import { scanTasksFromImage } from '../services/media';
import {
  loadDelegatedTasks,
  loadLanguage,
  loadTasks,
  saveDelegatedTasks,
  saveLanguage,
  saveTasks,
} from '../services/storage';
import {
  createRemoteTask,
  deleteRemoteTask,
  fetchRemoteDelegatedTasks,
  fetchRemoteTasks,
  transitionRemoteTaskLifecycle,
  transitionRemoteTaskDelegation,
  updateRemoteTask,
  updateRemoteTaskSchedule,
  updateRemoteTaskDelegation,
} from '../services/tasks';
import { resyncTaskReminders, syncTaskReminder } from '../services/reminders';
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
  markTaskPendingDelegation,
  markTaskPendingDelegationStatus,
  markTaskPendingLifecycle,
  markTaskPendingSchedule,
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
  const [delegatedTasks, setDelegatedTasks] = useState([]);
  const [taskView, setTaskView] = useState('owned');
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [aiCapabilities, setAiCapabilities] = useState(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [newTask, setNewTask] = useState(EMPTY_TASK);
  const tasksRef = useRef([]);
  const delegatedTasksRef = useRef([]);
  const syncInFlightRef = useRef(null);
  const suggestionInFlightRef = useRef(false);

  const t = translations[language];
  const quadrantOptions = useMemo(() => getQuadrantOptions(t), [t]);
  const groupedTasks = useMemo(
    () => groupTasksByQuadrant(taskView === 'delegated' ? delegatedTasks : tasks),
    [delegatedTasks, taskView, tasks]
  );
  const aiConnected = Boolean(
    aiCapabilities?.classification ||
    aiCapabilities?.reasoned_local_analysis ||
    aiCapabilities?.ocr ||
    aiCapabilities?.batch_analysis
  );
  const suggestDisabled =
    aiLoading || suggestLoading || aiCapabilities?.classification !== true;
  const scanDisabled = aiLoading || aiCapabilities?.ocr !== true;

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    delegatedTasksRef.current = delegatedTasks;
  }, [delegatedTasks]);

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      let nextLanguage = 'pl';
      let cachedTasks = getSampleTasks('pl');
      let cachedDelegatedTasks = [];

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
      try {
        cachedDelegatedTasks = await loadDelegatedTasks(nextLanguage);
      } catch {
        cachedDelegatedTasks = [];
      }

      const normalizedCachedTasks = normalizeStoredTasks(cachedTasks, nextLanguage);
      const normalizedCachedDelegatedTasks = normalizeStoredTasks(cachedDelegatedTasks, nextLanguage)
        .map((task) => ({ ...task, delegationRole: 'assignee' }));

      if (!active) {
        return;
      }

      setLanguage(nextLanguage);
      tasksRef.current = normalizedCachedTasks;
      setTasks(normalizedCachedTasks);
      delegatedTasksRef.current = normalizedCachedDelegatedTasks;
      setDelegatedTasks(normalizedCachedDelegatedTasks);
      setLoading(false);

      const [remoteTasksResult, capabilitiesResult] = await Promise.allSettled([
        runSingleFlight(syncInFlightRef, async () => {
          const [remoteTasks, remoteDelegatedTasks] = await Promise.all([
            fetchRemoteTasks(nextLanguage),
            fetchRemoteDelegatedTasks(nextLanguage),
          ]);
          const reconciledTasks = await reconcilePendingTasks({
            cachedTasks: normalizedCachedTasks,
            remoteTasks,
            language: nextLanguage,
            createRemoteTask,
            updateRemoteTask,
            updateRemoteTaskSchedule,
            updateRemoteTaskDelegation,
            transitionRemoteTaskDelegation,
            transitionRemoteTaskLifecycle,
            deleteRemoteTask,
          });
          const resolvedDelegatedTasks = await reconcilePendingTasks({
            cachedTasks: normalizedCachedDelegatedTasks,
            remoteTasks: remoteDelegatedTasks,
            language: nextLanguage,
            createRemoteTask,
            updateRemoteTask,
            updateRemoteTaskSchedule,
            updateRemoteTaskDelegation,
            transitionRemoteTaskDelegation,
            transitionRemoteTaskLifecycle,
            deleteRemoteTask,
          });
          const resolvedTasks = await resyncTaskReminders(reconciledTasks);
          await Promise.all([saveTasks(resolvedTasks), saveDelegatedTasks(resolvedDelegatedTasks)]);
          return {
            resolvedTasks,
            resolvedDelegatedTasks,
            success: !hasPendingTasks(resolvedTasks) && !hasPendingTasks(resolvedDelegatedTasks),
          };
        }),
        fetchAICapabilities(),
      ]);

      if (!active) {
        return;
      }

      if (remoteTasksResult.status === 'fulfilled') {
        const { resolvedTasks, resolvedDelegatedTasks } = remoteTasksResult.value;

        if (!active) {
          return;
        }

        tasksRef.current = resolvedTasks;
        setTasks(resolvedTasks);
        delegatedTasksRef.current = resolvedDelegatedTasks;
        setDelegatedTasks(resolvedDelegatedTasks);
        setNotice(
          hasPendingTasks(resolvedTasks) || hasPendingTasks(resolvedDelegatedTasks)
            ? translations[nextLanguage].pendingSyncNotice
            : translations[nextLanguage].syncedRemote
        );
      } else {
        const remindedCachedTasks = await resyncTaskReminders(normalizedCachedTasks);
        tasksRef.current = remindedCachedTasks;
        setTasks(remindedCachedTasks);
        await saveTasks(remindedCachedTasks);
        await saveDelegatedTasks(normalizedCachedDelegatedTasks);
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
      setDelegatedTasks([]);
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

  const persistDelegatedTasks = async (nextTasks, nextNotice = '') => {
    const normalizedTasks = normalizeStoredTasks(nextTasks, language)
      .map((task) => ({ ...task, delegationRole: 'assignee' }));
    delegatedTasksRef.current = normalizedTasks;
    setDelegatedTasks(normalizedTasks);
    setNotice(nextNotice);
    await saveDelegatedTasks(normalizedTasks);
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
    };
  };

  const retrySync = (cachedTasksOverride = null) => {
    const cachedTasks = Array.isArray(cachedTasksOverride)
      ? cachedTasksOverride
      : tasksRef.current;
    setNotice(t.syncing);

    return runSingleFlight(syncInFlightRef, async () => {
      try {
        const [remoteTasks, remoteDelegatedTasks] = await Promise.all([
          fetchRemoteTasks(language),
          fetchRemoteDelegatedTasks(language),
        ]);
        const reconciledTasks = await reconcilePendingTasks({
          cachedTasks,
          remoteTasks,
          language,
          createRemoteTask,
          updateRemoteTask,
          updateRemoteTaskSchedule,
          updateRemoteTaskDelegation,
          transitionRemoteTaskDelegation,
          transitionRemoteTaskLifecycle,
          deleteRemoteTask,
        });
        const resolvedDelegatedTasks = await reconcilePendingTasks({
          cachedTasks: delegatedTasksRef.current,
          remoteTasks: remoteDelegatedTasks,
          language,
          createRemoteTask,
          updateRemoteTask,
          updateRemoteTaskSchedule,
          updateRemoteTaskDelegation,
          transitionRemoteTaskDelegation,
          transitionRemoteTaskLifecycle,
          deleteRemoteTask,
        });
        const resolvedTasks = await resyncTaskReminders(reconciledTasks);
        const pending = hasPendingTasks(resolvedTasks) || hasPendingTasks(resolvedDelegatedTasks);
        await Promise.all([
          persistTasks(resolvedTasks, pending ? t.pendingSyncNotice : t.syncedRemote),
          persistDelegatedTasks(resolvedDelegatedTasks, pending ? t.pendingSyncNotice : t.syncedRemote),
        ]);
        return { resolvedTasks, success: !pending };
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

  const handleDelegatedResolveConflict = async (id, resolution) => {
    const conflictTask = delegatedTasksRef.current.find((task) => task.id === id);
    if (!conflictTask || conflictTask.syncState !== TASK_SYNC_STATE.conflict) return;
    const resolvedTask = resolveTaskConflict(conflictTask, resolution);
    const nextTasks = resolvedTask
      ? upsertTask(delegatedTasksRef.current, resolvedTask)
      : removeTask(delegatedTasksRef.current, conflictTask);
    await persistDelegatedTasks(nextTasks,
      hasPendingTasks(nextTasks) ? t.pendingSyncNotice : t.syncedRemote);
    if (resolution === 'local') await retrySync();
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
    const requestedTitle = newTask.title.trim();
    if (!requestedTitle || suggestionInFlightRef.current) {
      return;
    }

    suggestionInFlightRef.current = true;
    setSuggestLoading(true);
    try {
      const suggestion = await suggestTaskQuadrant(requestedTitle);
      setNewTask((current) => {
        if (current.title.trim() !== requestedTitle) {
          return current;
        }
        return {
          ...current,
          urgent: suggestion.urgent,
          important: suggestion.important,
        };
      });
    } catch (error) {
      setNotice(resolveSuggestionNotice(error, t));
    } finally {
      suggestionInFlightRef.current = false;
      setSuggestLoading(false);
    }
  };

  const handleDelete = async (id) => {
    const currentTask = tasksRef.current.find((task) => task.id === id);

    if (!currentTask) {
      return;
    }

    if (currentTask.lifecycleState !== 'trashed') {
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
      await deleteRemoteTask(remoteId, currentTask.revision, currentTask.lifecycleState);
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

  const handleLifecycle = async (id, action) => {
    const currentTask = tasksRef.current.find((task) => task.id === id);
    if (!currentTask || currentTask.syncState === TASK_SYNC_STATE.conflict) {
      return;
    }

    const localTask = markTaskPendingLifecycle(currentTask, action);
    if (!localTask) {
      return;
    }
    const nextTasks = upsertTask(tasksRef.current, localTask);
    const remoteId = getTaskRemoteId(currentTask);
    if (!remoteId) {
      await persistTasks(nextTasks, t.cachedLocal);
      return;
    }

    await persistTasks(nextTasks, t.pendingSyncNotice);
    try {
      const remoteTask = await transitionRemoteTaskLifecycle(
        remoteId,
        action,
        language,
        currentTask.revision,
      );
      await persistTasks(upsertTask(tasksRef.current, remoteTask), t.syncedRemote);
    } catch (error) {
      const pendingTask = markTaskSyncFailed(localTask, error);
      const pendingTasks = upsertTask(tasksRef.current, pendingTask);
      await persistTasks(pendingTasks, t.pendingSyncNotice);
      const status = Number(error?.status || error?.response?.status || 0);
      if (status === 409 || status === 412 || status === 428) {
        await retrySync(pendingTasks);
      }
    }
  };

  const handleSchedule = async (id, schedule) => {
    const currentTask = tasksRef.current.find((task) => task.id === id);
    if (!currentTask || currentTask.syncState === TASK_SYNC_STATE.conflict) {
      return;
    }

    const pendingTask = markTaskPendingSchedule(currentTask, schedule);
    let localTask = pendingTask;
    try {
      const reminder = await syncTaskReminder(pendingTask, { requestPermission: true });
      localTask = {
        ...pendingTask,
        ...(reminder.notificationId ? { notificationId: reminder.notificationId } : {}),
        reminderStatus: reminder.status,
      };
    } catch {
      localTask = { ...pendingTask, reminderStatus: 'error' };
    }

    const nextTasks = upsertTask(tasksRef.current, localTask);
    const remoteId = getTaskRemoteId(currentTask);
    await persistTasks(nextTasks, remoteId ? t.pendingSyncNotice : t.cachedLocal);
    if (!remoteId) return;

    try {
      const remoteTask = await updateRemoteTaskSchedule(
        remoteId,
        schedule,
        language,
        currentTask.revision,
      );
      const syncedTask = {
        ...remoteTask,
        ...(localTask.notificationId ? { notificationId: localTask.notificationId } : {}),
        reminderStatus: localTask.reminderStatus,
      };
      await persistTasks(upsertTask(tasksRef.current, syncedTask),
        localTask.reminderStatus === 'permission_denied'
          ? t.reminderPermissionDenied
          : localTask.reminderStatus === 'missed'
            ? t.reminderMissed
            : t.syncedRemote);
    } catch (error) {
      const failedTask = markTaskSyncFailed(localTask, error);
      const failedTasks = upsertTask(tasksRef.current, failedTask);
      await persistTasks(failedTasks, t.pendingSyncNotice);
      const status = Number(error?.status || error?.response?.status || 0);
      if (status === 409 || status === 412 || status === 428) {
        await retrySync(failedTasks);
      }
    }
  };

  const handleDelegation = async (id, delegation) => {
    const currentTask = tasksRef.current.find((task) => task.id === id);
    if (!currentTask || currentTask.syncState === TASK_SYNC_STATE.conflict) return;
    const localTask = markTaskPendingDelegation(currentTask, delegation);
    const nextTasks = upsertTask(tasksRef.current, localTask);
    const remoteId = getTaskRemoteId(currentTask);
    await persistTasks(nextTasks, remoteId ? t.pendingSyncNotice : t.cachedLocal);
    if (!remoteId) return;
    try {
      const remoteTask = await updateRemoteTaskDelegation(
        remoteId, delegation, language, currentTask.revision,
      );
      await persistTasks(upsertTask(tasksRef.current, remoteTask), t.syncedRemote);
    } catch (error) {
      const failedTask = markTaskSyncFailed(localTask, error);
      const failedTasks = upsertTask(tasksRef.current, failedTask);
      await persistTasks(failedTasks, t.pendingSyncNotice);
      const status = Number(error?.status || error?.response?.status || 0);
      if (status === 409 || status === 412 || status === 428) await retrySync(failedTasks);
    }
  };

  const handleDelegationStatus = async (id, status) => {
    const currentTask = delegatedTasksRef.current.find((task) => task.id === id);
    if (!currentTask || currentTask.syncState === TASK_SYNC_STATE.conflict) return;
    const localTask = markTaskPendingDelegationStatus(currentTask, status);
    if (!localTask) return;
    const nextTasks = upsertTask(delegatedTasksRef.current, localTask);
    await persistDelegatedTasks(nextTasks, t.pendingSyncNotice);
    try {
      const remoteTask = await transitionRemoteTaskDelegation(
        getTaskRemoteId(currentTask), status, language, currentTask.revision,
      );
      await persistDelegatedTasks(upsertTask(delegatedTasksRef.current, remoteTask), t.syncedRemote);
    } catch (error) {
      const failedTask = markTaskSyncFailed(localTask, error);
      const failedTasks = upsertTask(delegatedTasksRef.current, failedTask);
      await persistDelegatedTasks(failedTasks, t.pendingSyncNotice);
      const errorStatus = Number(error?.status || error?.response?.status || 0);
      if (errorStatus === 409 || errorStatus === 412 || errorStatus === 428) await retrySync();
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
    handleLifecycle,
    handleDelegation,
    handleDelegationStatus,
    handleDelegatedResolveConflict,
    handleResolveConflict,
    handleSchedule,
    handleScan,
    handleSuggest,
    handleToggle,
    importScannedTasks,
    language,
    loading,
    newTask,
    notice,
    quadrantOptions,
    refreshCapabilities,
    retrySync,
    scanDisabled,
    suggestDisabled,
    taskView,
    setTaskView,
    t,
    updateNewTaskField,
  };
}
