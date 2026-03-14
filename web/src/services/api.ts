import apiClient, {
  type AcceptedOcrTaskDto,
  type AICapabilitiesDto,
  type AIProviderControlDto,
  type AIProviderName,
  type BatchAnalysisResultDto,
  type ClassificationResultDto,
  type LangChainAnalysisDto,
  type OcrResultDto,
  type SimilarExampleResultDto,
  type TaskDto,
  type TaskInputDto,
  type TrainingDataClearResultDto,
  type TrainingStatsDto,
} from '@eisenhower/api-client';
import { runtimeConfig } from '../config';
import type { Language } from '../i18n/translations';

const { createAiApi, createTaskApi } = apiClient;

function getTaskApi() {
  return createTaskApi(runtimeConfig.apiUrl);
}

function getAiApi() {
  return createAiApi(runtimeConfig.aiApiUrl);
}

export type ClassificationResult = ClassificationResultDto;
export type SimilarExampleResult = SimilarExampleResultDto;
export type LangChainAnalysis = LangChainAnalysisDto;
export type OCRResult = OcrResultDto;
export type BatchAnalysisResult = BatchAnalysisResultDto;
export type TrainingStats = TrainingStatsDto;
export type AICapabilities = AICapabilitiesDto;
export type AIProviderControl = AIProviderControlDto;
export type OCRAcceptedTask = AcceptedOcrTaskDto;
export type TrainingDataClearResult = TrainingDataClearResultDto;
export type { AIProviderName, TaskDto, TaskInputDto };

export async function getTasks(): Promise<TaskDto[]> {
  return getTaskApi().listTasks();
}

export async function createTask(task: TaskInputDto): Promise<TaskDto> {
  return getTaskApi().createTask(task);
}

export async function updateTask(id: string, patch: Partial<TaskInputDto>): Promise<TaskDto> {
  return getTaskApi().updateTask(id, patch);
}

export async function deleteTask(id: string): Promise<void> {
  await getTaskApi().deleteTask(id);
}

export async function classifyTask(title: string): Promise<ClassificationResult> {
  return getAiApi().classifyTask(title, true);
}

export async function analyzeWithLangChain(task: string, language: Language = 'en'): Promise<LangChainAnalysis> {
  return getAiApi().analyzeWithLangChain(task, language);
}

export async function extractTasksFromImage(file: File): Promise<OCRResult> {
  return getAiApi().extractTasksFromImage(file);
}

export async function batchAnalyzeTasks(tasks: string[]): Promise<BatchAnalysisResult> {
  return getAiApi().batchAnalyzeTasks(tasks);
}

export async function addTrainingExample(text: string, quadrant: number): Promise<void> {
  await getAiApi().addTrainingExample(text, quadrant);
}

export async function retrainModel(
  preserveExperience = true
): Promise<{ preserve_experience: boolean; preserve_experience_deprecated?: boolean }> {
  return getAiApi().retrainModel(preserveExperience);
}

export async function learnFromFeedback(
  task: string,
  predictedQuadrant: number,
  correctQuadrant: number
): Promise<void> {
  await getAiApi().learnFromFeedback(task, predictedQuadrant, correctQuadrant);
}

export async function learnFromAcceptedOCRTasks(
  tasks: OCRAcceptedTask[],
  retrain = true
): Promise<{ examples_added: number; retrained: boolean }> {
  return getAiApi().learnFromAcceptedOcrTasks(tasks, retrain);
}

export async function getTrainingStats(): Promise<TrainingStats> {
  return getAiApi().fetchTrainingStats();
}

export async function clearTrainingData(keepDefaults = true): Promise<TrainingDataClearResult> {
  return getAiApi().clearTrainingData(keepDefaults);
}

export async function getExamplesByQuadrant(quadrant: number, limit = 10): Promise<{ examples: Array<{ text: string; quadrant: number }> }> {
  return getAiApi().getExamplesByQuadrant(quadrant, limit);
}

export async function getCapabilities(): Promise<AICapabilities> {
  return getAiApi().fetchCapabilities();
}

export async function setProviderEnabled(
  provider: AIProviderName,
  enabled: boolean
): Promise<{ provider: AIProviderName } & AIProviderControl> {
  return getAiApi().setProviderEnabled(provider, enabled);
}
