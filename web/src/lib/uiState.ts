import type { Language } from '../i18n/translations';
import { LangChainAnalysis } from '../services/api';
import { Task } from '../types';

export function replaceTaskById(tasks: Task[], id: string, updated: Task) {
  return tasks.map((task) => (task._id === id ? updated : task));
}

export function restoreReadyState(cancelled: boolean, onReady: () => void) {
  if (!cancelled) {
    onReady();
  }
}

export async function runAdvancedTaskAnalysis(
  taskTitle: string,
  language: Language,
  analyze: (task: string, language: Language) => Promise<LangChainAnalysis>
) {
  const normalizedTaskTitle = taskTitle.trim();

  if (!normalizedTaskTitle) {
    return null;
  }

  return analyze(normalizedTaskTitle, language);
}

export function applyAdvancedAnalysisResult(
  result: LangChainAnalysis | null,
  onResult: (analysis: LangChainAnalysis) => void
) {
  if (!result) {
    return;
  }

  onResult(result);
}
