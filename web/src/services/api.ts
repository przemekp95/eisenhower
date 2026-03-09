import { runtimeConfig } from '../config';
import type { Language } from '../i18n/translations';
import { Task, TaskInput } from '../types';

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      throw new Error(payload.error ?? 'Request failed');
    }
    throw new Error('Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export interface ClassificationResult {
  task: string;
  urgent: boolean;
  important: boolean;
  quadrant: number;
  quadrant_name: string;
  timestamp: string;
  method: string;
  confidence?: number;
}

export interface SimilarExampleResult {
  text: string;
  quadrant: number;
  quadrant_name: string;
  source: string;
  score: number;
}

export interface LangChainAnalysis {
  task: string;
  langchain_analysis: {
    quadrant: number | null;
    reasoning: string;
    confidence: number;
    method: string;
  };
  rag_classification: {
    quadrant: number;
    quadrant_name: string;
    confidence: number;
  };
  comparison: {
    methods_agree: boolean;
    confidence_difference: number;
  };
  timestamp: string;
}

export interface OCRResult {
  filename: string;
  image_info: {
    size_bytes: number;
    shape: string;
  };
  ocr: {
    extracted_text: string;
    raw_tasks_detected: number;
    method: string;
  };
  classified_tasks: Array<{
    text: string;
    quadrant: number;
    quadrant_name: string;
    confidence: number;
  }>;
  summary: {
    total_tasks: number;
    quadrant_distribution: {
      counts: { [key: number]: number };
      percentages: { [key: number]: number };
      quadrant_names: { [key: number]: string };
    };
  };
  timestamp: string;
}

export interface BatchAnalysisResult {
  batch_results: Array<{
    task: string;
    analyses: {
      rag: {
        quadrant: number;
        confidence: number;
        quadrant_name: string;
      };
      langchain: {
        quadrant: number;
        confidence: number;
        reasoning: string;
      };
    };
  }>;
  summary: {
    methods: Record<string, { quadrant_distribution: Record<string, number> }>;
    total_tasks: number;
  };
  timestamp: string;
}

export interface TrainingStats {
  total_examples: number;
  quadrant_distribution: { [key: string]: number };
  data_sources: { [key: string]: number };
  data_file: string;
  model_file: string;
  model_name?: string;
  model_ready?: boolean;
  model_encoder?: string;
  model_trained_at?: string | null;
  model_validation_skipped?: boolean;
  model_error?: string | null;
  last_updated: string;
}

export interface AICapabilities {
  classification: boolean;
  langchain_analysis: boolean;
  ocr: boolean;
  batch_analysis: boolean;
  training_management: boolean;
  providers: {
    local_model: boolean;
    tesseract?: boolean;
    ocr: boolean;
  };
  model?: {
    ready: boolean;
    name: string;
    encoder_name: string;
    artifact_path: string;
    index_path: string;
    trained_at?: string | null;
    validation_skipped?: boolean;
    last_error?: string | null;
    examples_seen?: number;
  };
}

export interface TrainingDataClearResult {
  message: string;
  remaining_examples: number;
}

export async function getTasks(): Promise<Task[]> {
  const response = await fetch(`${runtimeConfig.apiUrl}/tasks`);
  return readJson<Task[]>(response);
}

export async function createTask(task: TaskInput): Promise<Task> {
  const response = await fetch(`${runtimeConfig.apiUrl}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  });
  return readJson<Task>(response);
}

export async function updateTask(id: string, patch: Partial<TaskInput>): Promise<Task> {
  const response = await fetch(`${runtimeConfig.apiUrl}/tasks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return readJson<Task>(response);
}

export async function deleteTask(id: string): Promise<void> {
  const response = await fetch(`${runtimeConfig.apiUrl}/tasks/${id}`, {
    method: 'DELETE',
  });
  await readJson<void>(response);
}

export async function classifyTask(title: string): Promise<ClassificationResult> {
  const response = await fetch(
    `${runtimeConfig.aiApiUrl}/classify?title=${encodeURIComponent(title)}&use_rag=true`
  );
  return readJson<ClassificationResult>(response);
}

export async function analyzeWithLangChain(task: string, language: Language = 'en'): Promise<LangChainAnalysis> {
  const response = await fetch(
    `${runtimeConfig.aiApiUrl}/analyze-langchain?task=${encodeURIComponent(task)}&language=${language}`,
    { method: 'POST' }
  );
  return readJson<LangChainAnalysis>(response);
}

export async function extractTasksFromImage(file: File): Promise<OCRResult> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${runtimeConfig.aiApiUrl}/extract-tasks-from-image`, {
    method: 'POST',
    body: formData,
  });

  return readJson<OCRResult>(response);
}

export async function batchAnalyzeTasks(tasks: string[]): Promise<BatchAnalysisResult> {
  const response = await fetch(`${runtimeConfig.aiApiUrl}/batch-analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks }),
  });
  return readJson<BatchAnalysisResult>(response);
}

export async function addTrainingExample(text: string, quadrant: number): Promise<void> {
  const response = await fetch(`${runtimeConfig.aiApiUrl}/add-example`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ text, quadrant: quadrant.toString() }),
  });
  await readJson<void>(response);
}

export async function retrainModel(
  preserveExperience = true
): Promise<{ preserve_experience: boolean; preserve_experience_deprecated?: boolean }> {
  const response = await fetch(`${runtimeConfig.aiApiUrl}/retrain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ preserve_experience: preserveExperience.toString() }),
  });
  return readJson<{ preserve_experience: boolean; preserve_experience_deprecated?: boolean }>(response);
}

export async function learnFromFeedback(
  task: string,
  predictedQuadrant: number,
  correctQuadrant: number
): Promise<void> {
  const response = await fetch(`${runtimeConfig.aiApiUrl}/learn-feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      task,
      predicted_quadrant: predictedQuadrant.toString(),
      correct_quadrant: correctQuadrant.toString(),
    }),
  });
  await readJson<void>(response);
}

export async function getTrainingStats(): Promise<TrainingStats> {
  const response = await fetch(`${runtimeConfig.aiApiUrl}/training-stats`);
  return readJson<TrainingStats>(response);
}

export async function clearTrainingData(keepDefaults = true): Promise<TrainingDataClearResult> {
  const response = await fetch(`${runtimeConfig.aiApiUrl}/training-data?keep_defaults=${keepDefaults}`, {
    method: 'DELETE',
  });
  return readJson<TrainingDataClearResult>(response);
}

export async function getExamplesByQuadrant(quadrant: number, limit = 10): Promise<{ examples: Array<{ text: string; quadrant: number }> }> {
  const response = await fetch(`${runtimeConfig.aiApiUrl}/examples/${quadrant}?limit=${limit}`);
  return readJson<{ examples: Array<{ text: string; quadrant: number }> }>(response);
}

export async function getCapabilities(): Promise<AICapabilities> {
  const response = await fetch(`${runtimeConfig.aiApiUrl}/capabilities`);
  return readJson<AICapabilities>(response);
}
