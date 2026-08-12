import { QUADRANT_DEFINITIONS } from '@eisenhower/api-client';
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
  const definition = QUADRANT_DEFINITIONS.find(({ value }) => value === quadrant);
  return definition
    ? { urgent: definition.urgent, important: definition.important }
    : { urgent: false, important: false };
}

export function flagsToQuadrant(task) {
  return QUADRANT_DEFINITIONS.find(
    ({ urgent, important }) => urgent === Boolean(task.urgent) && important === Boolean(task.important)
  )?.value ?? 3;
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
