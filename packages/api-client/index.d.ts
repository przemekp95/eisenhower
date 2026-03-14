export interface TaskDto {
  _id: string;
  title: string;
  description: string;
  urgent: boolean;
  important: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface TaskInputDto {
  title: string;
  description: string;
  urgent: boolean;
  important: boolean;
}

export type HealthState = 'healthy' | 'unhealthy' | 'unreachable';
export type DatabaseState = 'connected' | 'disconnected';

export interface HealthResponseDto {
  status: 'ok' | 'ready' | 'not_ready';
  timestamp: string;
  services: {
    database: DatabaseState;
    ai: HealthState;
  };
}

export interface ClassificationResultDto {
  task: string;
  urgent: boolean;
  important: boolean;
  quadrant: number;
  quadrant_name: string;
  timestamp: string;
  method: string;
  confidence?: number;
}

export interface SimilarExampleResultDto {
  text: string;
  quadrant: number;
  quadrant_name: string;
  source: string;
  score: number;
}

export interface LangChainAnalysisDto {
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
  timestamp?: string;
}

export interface OcrResultDto {
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
    similar_examples_used?: number;
    top_similar_examples?: SimilarExampleResultDto[];
  }>;
  summary: {
    total_tasks: number;
    quadrant_distribution: {
      counts: Record<string, number>;
      percentages: Record<string, number>;
      quadrant_names: Record<string, string>;
    };
  };
  timestamp?: string;
}

export interface BatchAnalysisResultDto {
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
  timestamp?: string;
}

export interface TrainingStatsDto {
  total_examples: number;
  quadrant_distribution: Record<string, number>;
  data_sources: Record<string, number>;
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

export interface AIProviderControlDto {
  enabled: boolean;
  available: boolean;
  active: boolean;
  reason?: string | null;
}

export type AIProviderName = 'local_model' | 'tesseract';

export interface AICapabilitiesDto {
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
  provider_controls?: {
    local_model: AIProviderControlDto;
    tesseract: AIProviderControlDto;
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

export interface TrainingDataClearResultDto {
  message: string;
  remaining_examples: number;
}

export interface AcceptedOcrTaskDto {
  text: string;
  quadrant: number;
}

export interface AcceptedOcrLearningTaskLike {
  text?: string;
  title?: string;
  quadrant?: number;
  urgent?: boolean;
  important?: boolean;
}

export const TASK_API_PATHS: {
  readonly tasks: '/tasks';
  readonly health: '/health';
  readonly readiness: '/health/ready';
};

export const AI_API_PATHS: {
  readonly capabilities: '/capabilities';
  readonly trainingStats: '/training-stats';
  readonly classify: '/classify';
  readonly analyzeWithLangChain: '/analyze-langchain';
  readonly extractTasksFromImage: '/extract-tasks-from-image';
  readonly batchAnalyzeTasks: '/batch-analyze';
  readonly addTrainingExample: '/add-example';
  readonly learnFromFeedback: '/learn-feedback';
  readonly learnFromAcceptedOcrTasks: '/learn-ocr-feedback';
  readonly retrainModel: '/retrain';
  readonly clearTrainingData: '/training-data';
};

export interface TaskApiClient {
  paths: typeof TASK_API_PATHS;
  listTasks(): Promise<TaskDto[]>;
  createTask(task: TaskInputDto): Promise<TaskDto>;
  updateTask(id: string, patch: Partial<TaskInputDto>): Promise<TaskDto>;
  deleteTask(id: string): Promise<null>;
  getHealth(): Promise<HealthResponseDto>;
  getReadiness(): Promise<HealthResponseDto>;
}

export interface AiApiClient {
  paths: typeof AI_API_PATHS;
  classifyTask(title: string, useRag?: boolean): Promise<ClassificationResultDto>;
  analyzeWithLangChain(task: string, language?: string): Promise<LangChainAnalysisDto>;
  extractTasksFromImage(file: unknown): Promise<OcrResultDto>;
  batchAnalyzeTasks(tasks: string[]): Promise<BatchAnalysisResultDto>;
  fetchCapabilities(): Promise<AICapabilitiesDto>;
  fetchTrainingStats(): Promise<TrainingStatsDto>;
  setProviderEnabled(provider: AIProviderName, enabled: boolean): Promise<{ provider: AIProviderName } & AIProviderControlDto>;
  addTrainingExample(text: string, quadrant: number): Promise<void>;
  learnFromFeedback(task: string, predictedQuadrant: number, correctQuadrant: number): Promise<void>;
  learnFromAcceptedOcrTasks(tasks: AcceptedOcrLearningTaskLike[], retrain?: boolean): Promise<{ examples_added: number; retrained: boolean }>;
  retrainModel(preserveExperience?: boolean): Promise<{ preserve_experience: boolean; preserve_experience_deprecated?: boolean }>;
  clearTrainingData(keepDefaults?: boolean): Promise<TrainingDataClearResultDto>;
  getExamplesByQuadrant(quadrant: number, limit?: number): Promise<{ examples: Array<{ text: string; quadrant: number }> }>;
}

export function buildUrl(baseUrl: string, path: string): string;
export function createRequestError(message: string, details?: { code?: string; status?: number }): Error & { code?: string; status?: number };
export function readJson<T>(response: Response, options?: { defaultError?: string; errorCode?: string }): Promise<T>;
export function toTaskInputDto(task: Partial<TaskInputDto> & { title: string }): TaskInputDto;
export function toTaskPatchDto(patch: Partial<TaskInputDto>): Partial<TaskInputDto>;
export function resolveTaskQuadrant(task: AcceptedOcrLearningTaskLike): number;
export function toAcceptedOcrLearningPayload(tasks: AcceptedOcrLearningTaskLike[]): Array<{ task: string; quadrant: number }>;
export function createTaskApi(baseUrl: string, fetchImpl?: typeof fetch): TaskApiClient;
export function createAiApi(baseUrl: string, fetchImpl?: typeof fetch): AiApiClient;
export function getProviderPath(provider: string): string;
export function getExamplesByQuadrantPath(quadrant: number, limit?: number): string;
export function getClassifyPath(title: string, useRag?: boolean): string;
export function getAnalyzeWithLangChainPath(task: string, language?: string): string;
export function getClearTrainingDataPath(keepDefaults?: boolean): string;
export function isTaskDto(value: unknown): value is TaskDto;
export function isHealthResponseDto(value: unknown): value is HealthResponseDto;
export function isClassificationResultDto(value: unknown): value is ClassificationResultDto;
export function isLangChainAnalysisDto(value: unknown): value is LangChainAnalysisDto;
export function isBatchAnalysisResultDto(value: unknown): value is BatchAnalysisResultDto;
export function isOcrResultDto(value: unknown): value is OcrResultDto;
