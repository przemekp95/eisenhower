import {
  TASK_SYNC_STATE,
  createPendingTask,
  isTaskVisible,
} from './taskSync';

export function getSampleTasks(language) {
  return [
    {
      id: 'seed-1',
      title: language === 'pl' ? 'Pilny raport dla klienta' : 'Urgent client report',
      description: language === 'pl' ? 'Termin dzisiaj' : 'Due today',
      urgent: true,
      important: true,
      locale: language,
      remoteId: null,
      syncState: TASK_SYNC_STATE.localSeed,
    },
    {
      id: 'seed-2',
      title: language === 'pl' ? 'Plan treningowy' : 'Workout plan',
      description: language === 'pl' ? 'Długoterminowy cel' : 'Long-term goal',
      urgent: false,
      important: true,
      locale: language,
      remoteId: null,
      syncState: TASK_SYNC_STATE.localSeed,
    },
  ];
}

export function classifyTaskFallback(title) {
  const lower = title.toLowerCase();
  const urgent = ['urgent', 'pilne', 'pilny', 'deadline', 'today', 'dzisiaj'].some((word) =>
    lower.includes(word)
  );
  const important = ['important', 'ważne', 'ważny', 'client', 'klient', 'roadmap', 'plan'].some((word) =>
    lower.includes(word)
  );

  return { urgent, important };
}

export function quadrantToFlags(quadrant) {
  return {
    urgent: quadrant === 0 || quadrant === 1,
    important: quadrant === 0 || quadrant === 2,
  };
}

export function flagsToQuadrant(task) {
  if (task.urgent && task.important) {
    return 0;
  }

  if (task.urgent) {
    return 1;
  }

  if (task.important) {
    return 2;
  }

  return 3;
}

export function groupTasksByQuadrant(tasks) {
  const grouped = {
    0: [],
    1: [],
    2: [],
    3: [],
  };

  for (const task of tasks) {
    if (!isTaskVisible(task)) {
      continue;
    }

    grouped[flagsToQuadrant(task)].push(task);
  }

  return grouped;
}

export function createTaskRecord(language, task, id) {
  return createPendingTask(language, task, id);
}

export function mergeTasks(existingTasks, incomingTasks) {
  const seen = new Set();
  const merged = [];

  for (const task of [...incomingTasks, ...existingTasks]) {
    const identity = `${task.title}`.trim().toLowerCase() + '::' + `${task.description || ''}`.trim().toLowerCase();
    if (!task.title?.trim() || seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    merged.push(task);
  }

  return merged;
}
