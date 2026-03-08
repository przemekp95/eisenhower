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
  analyze: (task: string) => Promise<LangChainAnalysis>
) {
  const normalizedTaskTitle = taskTitle.trim();

  if (!normalizedTaskTitle) {
    return null;
  }

  return analyze(normalizedTaskTitle);
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
