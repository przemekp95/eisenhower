import apiClient, {
  type AICapabilitiesDto,
  type BatchAnalysisResultDto,
  type ClassificationResultDto,
  type GroundedAnalysisDto,
  type KnowledgeAnswerDto,
  type TaskAnalysisDto,
  type OcrResultDto,
  type SimilarExampleResultDto,
  type TaskDto,
  type TaskDelegationAssignmentDto,
  type TaskDelegationStatus,
  type TaskInputDto,
  type TaskLifecycleAction,
  type TaskLifecycleFilter,
  type TaskScheduleDto,
  type CalendarStatusDto,
  type CalendarConflictDto,
  type MemoryConfirmResponseDto,
  type MemoryConsentReceipt,
  type MemoryExportResponseDto,
  type MemoryIntentDto,
  type MemoryPrepareResponseDto,
} from '@eisenhower/api-client';
import { runtimeConfig } from '../config';
import type { Language } from '../i18n/translations';
import { clearApiToken, getAccessToken, setApiToken, rejectApiToken } from '../authSession';

const { createAiApi, createTaskApi } = apiClient;

export { clearApiToken, setApiToken };

function fetchWithoutAmbientCredentials(input: RequestInfo | URL, init?: RequestInit) {
  return globalThis.fetch(input, { ...init, credentials: 'omit' });
}

function getTaskApi() {
  return createTaskApi(runtimeConfig.apiUrl, {
    fetch: fetchWithoutAmbientCredentials,
    accessToken: getAccessToken,
    onUnauthorized: rejectApiToken,
  });
}

function getAiApi() {
  return createAiApi(runtimeConfig.aiApiUrl, {
    fetch: fetchWithoutAmbientCredentials,
    accessToken: getAccessToken,
    onUnauthorized: rejectApiToken,
  });
}

export type ClassificationResult = ClassificationResultDto;
export type GroundedAnalysis = GroundedAnalysisDto;
export type KnowledgeAnswer = KnowledgeAnswerDto;
export type SimilarExampleResult = SimilarExampleResultDto;
export type TaskAnalysis = TaskAnalysisDto;
/** @deprecated Use TaskAnalysis. */
export type LangChainAnalysis = TaskAnalysis;
export type OCRResult = OcrResultDto;
export type BatchAnalysisResult = BatchAnalysisResultDto;
export type AICapabilities = AICapabilitiesDto;
export type {
  MemoryConfirmResponseDto,
  MemoryConsentReceipt,
  MemoryExportResponseDto,
  MemoryIntentDto,
  MemoryPrepareResponseDto,
};
export type {
  TaskDto,
  TaskDelegationAssignmentDto,
  TaskDelegationStatus,
  TaskInputDto,
  TaskLifecycleAction,
  TaskLifecycleFilter,
  TaskScheduleDto,
  CalendarStatusDto,
  CalendarConflictDto,
};

export async function getTasks(lifecycle: TaskLifecycleFilter = 'active'): Promise<TaskDto[]> {
  return getTaskApi().listTasks(lifecycle);
}

export async function getDelegatedTasks(
  lifecycle: TaskLifecycleFilter = 'active'
): Promise<TaskDto[]> {
  return getTaskApi().listDelegatedTasks(lifecycle);
}

export async function createTask(task: TaskInputDto, idempotencyKey?: string): Promise<TaskDto> {
  return getTaskApi().createTask(task, idempotencyKey);
}

export async function updateTask(
  id: string,
  patch: Partial<TaskInputDto>,
  revision?: number
): Promise<TaskDto> {
  return getTaskApi().updateTask(id, patch, revision);
}

export async function transitionTaskLifecycle(
  id: string,
  action: TaskLifecycleAction,
  revision?: number
): Promise<TaskDto> {
  return getTaskApi().transitionTaskLifecycle(id, action, revision);
}

export async function updateTaskSchedule(
  id: string,
  schedule: TaskScheduleDto | null,
  revision?: number
): Promise<TaskDto> {
  return getTaskApi().updateTaskSchedule(id, schedule, revision);
}

export async function updateTaskDelegation(
  id: string,
  delegation: TaskDelegationAssignmentDto | null,
  revision?: number
): Promise<TaskDto> {
  return getTaskApi().updateTaskDelegation(id, delegation, revision);
}

export async function transitionTaskDelegation(
  id: string,
  status: TaskDelegationStatus,
  revision?: number
): Promise<TaskDto> {
  return getTaskApi().transitionTaskDelegation(id, status, revision);
}

export async function deleteTask(id: string, revision?: number): Promise<void> {
  await getTaskApi().deleteTask(id, revision);
}

export async function getCalendarStatus(): Promise<CalendarStatusDto> {
  return getTaskApi().getCalendarStatus();
}

export async function startCalendarConnection(
  returnPath: string
): Promise<{ authorizationUrl: string }> {
  return getTaskApi().startCalendarConnection(returnPath);
}

export async function disconnectCalendar(): Promise<void> {
  await getTaskApi().disconnectCalendar();
}

export async function requestCalendarSync(idempotencyKey: string): Promise<{ eventId: string }> {
  return getTaskApi().requestCalendarSync(idempotencyKey);
}

export async function getCalendarConflicts(): Promise<CalendarConflictDto[]> {
  return getTaskApi().listCalendarConflicts();
}

export async function resolveCalendarConflict(
  id: string,
  strategy: 'eisenhower' | 'google',
  revision: number,
  idempotencyKey: string
): Promise<CalendarConflictDto> {
  return getTaskApi().resolveCalendarConflict(id, strategy, revision, idempotencyKey);
}

export async function classifyTask(title: string): Promise<ClassificationResult> {
  return getAiApi().classifyTask(title, true);
}

export async function analyzeTask(
  task: string,
  language: Language = 'en',
  options: { signal?: AbortSignal } = {}
): Promise<TaskAnalysis> {
  return getAiApi().analyzeTask(task, language, options);
}

export async function analyzeTaskWithRag(task: string): Promise<GroundedAnalysis> {
  return getAiApi().analyzeTaskWithRag(task);
}

export async function answerKnowledge(
  query: string,
  language: Language = 'en',
  options: { signal?: AbortSignal } = {}
): Promise<KnowledgeAnswer> {
  return getAiApi().answerKnowledge(query, language, null, 5, options);
}

/** @deprecated Use analyzeTask. */
export const analyzeWithLangChain = analyzeTask;

export async function extractTasksFromImage(
  file: File,
  options: { signal?: AbortSignal } = {}
): Promise<OCRResult> {
  return getAiApi().extractTasksFromImage(file, options);
}

export async function batchAnalyzeTasks(
  tasks: string[],
  options: { signal?: AbortSignal } = {}
): Promise<BatchAnalysisResult> {
  return getAiApi().batchAnalyzeTasks(tasks, options);
}

export async function getCapabilities(
  options: { signal?: AbortSignal } = {}
): Promise<AICapabilities> {
  return getAiApi().fetchCapabilities(options);
}

export async function prepareMemory(
  intent: MemoryIntentDto,
  options: { signal?: AbortSignal } = {}
): Promise<MemoryPrepareResponseDto> {
  return getAiApi().prepareMemory(intent, options);
}

export async function confirmMemory(
  intent: MemoryIntentDto,
  receipt: MemoryConsentReceipt,
  idempotencyKey: string,
  options: { signal?: AbortSignal } = {}
): Promise<MemoryConfirmResponseDto> {
  return getAiApi().confirmMemory(intent, receipt, idempotencyKey, options);
}

export async function exportMemory(
  options: { signal?: AbortSignal } = {}
): Promise<MemoryExportResponseDto> {
  return getAiApi().exportMemory(options);
}
