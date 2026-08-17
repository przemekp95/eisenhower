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

const { createAiApi, createTaskApi, stripImageMetadata } = apiClient;

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

function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image bytes'));
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error('Unable to read image bytes'));
        return;
      }
      resolve(new Uint8Array(reader.result));
    };
    reader.readAsArrayBuffer(file);
  });
}

function hasKnownImageSignature(bytes: Uint8Array): boolean {
  const asciiAt = (offset: number, value: string) =>
    Array.from(value).every(
      (character, index) => bytes[offset + index] === character.charCodeAt(0)
    );
  const bmffBoxLength = bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
  const isIsoBmffImage =
    bytes.length >= 12 &&
    bmffBoxLength >= 12 &&
    bmffBoxLength <= bytes.length &&
    asciiAt(4, 'ftyp') &&
    ['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].some((brand) =>
      asciiAt(8, brand)
    );

  return (
    (bytes[0] === 0xff && bytes[1] === 0xd8) ||
    (bytes[0] === 0x89 && asciiAt(1, 'PNG')) ||
    asciiAt(0, 'GIF87a') ||
    asciiAt(0, 'GIF89a') ||
    asciiAt(0, 'BM') ||
    (asciiAt(0, 'RIFF') && asciiAt(8, 'WEBP')) ||
    isIsoBmffImage
  );
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read text bytes'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file, 'utf-8');
  });
}

async function isSafeTextUpload(file: File, bytes: Uint8Array): Promise<boolean> {
  if (
    !(file.type.startsWith('text/') || /\.txt$/i.test(file.name)) ||
    hasKnownImageSignature(bytes)
  ) {
    return false;
  }

  try {
    const text = await readFileText(file);
    return !/[\ufffd\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);
  } catch {
    return false;
  }
}

export async function sanitizeOcrFile(file: File): Promise<File> {
  const bytes = await readFileBytes(file);
  let sanitized: Uint8Array;
  try {
    sanitized = stripImageMetadata(bytes);
  } catch (error) {
    if (await isSafeTextUpload(file, bytes)) {
      return file;
    }
    throw error;
  }
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const extension = pngSignature.every((byte, index) => sanitized[index] === byte) ? 'png' : 'jpg';
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'scan';
  return new File([sanitized], `${baseName}-sanitized.${extension}`, {
    type: extension === 'png' ? 'image/png' : 'image/jpeg',
    lastModified: file.lastModified,
  });
}

export async function extractTasksFromImage(
  file: File,
  options: { signal?: AbortSignal } = {}
): Promise<OCRResult> {
  return getAiApi().extractTasksFromImage(await sanitizeOcrFile(file), options);
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
