export function getSampleTasks(language) {
  return [
    {
      id: 'seed-1',
      title: language === 'pl' ? 'Pilny raport dla klienta' : 'Urgent client report',
      description: language === 'pl' ? 'Termin dzisiaj' : 'Due today',
      urgent: true,
      important: true,
    },
    {
      id: 'seed-2',
      title: language === 'pl' ? 'Plan treningowy' : 'Workout plan',
      description: language === 'pl' ? 'Długoterminowy cel' : 'Long-term goal',
      urgent: false,
      important: true,
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

export function createTaskRecord(language, task, id) {
  return {
    id,
    title: task.title.trim(),
    description: task.description.trim(),
    urgent: Boolean(task.urgent),
    important: Boolean(task.important),
    locale: language,
  };
}
