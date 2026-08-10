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

export interface QuadrantDefinition {
  readonly value: 0 | 1 | 2 | 3;
  readonly key: 'do' | 'delegate' | 'schedule' | 'delete';
  readonly name: 'Do Now' | 'Delegate' | 'Schedule' | 'Delete';
  readonly urgent: boolean;
  readonly important: boolean;
}

export const QUADRANT_DEFINITIONS: readonly QuadrantDefinition[];

export type HealthState = 'healthy' | 'unhealthy' | 'unreachable';
export type DatabaseState = 'connected' | 'disconnected';

export interface HealthResponseDto {
  status: 'ok' | 'ready' | 'not_ready';
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

export interface TaskAnalysisDto {
  task: string;
  /** Legacy wire key retained until the server contract is versioned. */
  langchain_analysis: {
    quadrant: number | null;
    reasoning: string;
    confidence: number;
    method: string;
  };
  /** Legacy wire key retained until the server contract is versioned. */
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

/** @deprecated Use TaskAnalysisDto. The endpoint does not guarantee LangChain execution. */
export type LangChainAnalysisDto = TaskAnalysisDto;

export interface CitationDto {
  chunk_id: string;
  document_id: string;
  source_uri: string;
  title: string;
  excerpt: string;
  score: number;
  content_version: string;
}

export interface GroundedAnalysisDto {
  mode: 'rag' | 'fallback' | 'no_answer';
  quadrant: number | null;
  quadrant_name: string | null;
  confidence: number | null;
  explanation: string;
  citations: CitationDto[];
  retrieval: {
    hit_count: number;
    top_score: number | null;
    embedding_version: string | null;
  };
  fallback_reason?: string | null;
}

export interface KnowledgeSearchDto {
  query: string;
  answer: string | null;
  citations: CitationDto[];
  retrieval: GroundedAnalysisDto['retrieval'];
  no_answer_reason?: string;
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
  reasoned_local_analysis?: boolean;
  retrieval_augmented_generation?: boolean;
  local_similar_examples?: boolean;
  /** @deprecated Always false; no production LangChain analysis provider exists. */
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
  legacy?: {
    langchain_analysis: false;
    analyze_langchain_route: 'deprecated_alias';
    use_rag_parameter: 'deprecated_alias_for_similar_examples';
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
  readonly analyzeTask: '/analyze';
  /** @deprecated Use analyzeTask. */
  readonly analyzeWithLangChain: '/analyze-langchain';
  readonly analyzeTaskWithRag: '/v2/ai/analyze';
  readonly knowledgeSearch: '/v2/knowledge/search';
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
  classifyTask(title: string, includeSimilarExamples?: boolean): Promise<ClassificationResultDto>;
  analyzeTask(task: string, language?: string): Promise<TaskAnalysisDto>;
  /** @deprecated Use analyzeTask. Retained for compatibility with older clients. */
  analyzeWithLangChain(task: string, language?: string): Promise<LangChainAnalysisDto>;
  analyzeTaskWithRag(task: string): Promise<GroundedAnalysisDto>;
  searchKnowledge(query: string, projectId?: string | null, limit?: number): Promise<KnowledgeSearchDto>;
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
export interface ApiClientOptions {
  fetch?: typeof fetch;
  accessToken?: string | (() => string | null);
  adminToken?: string | (() => string | null);
  onUnauthorized?: () => void;
  onAdminUnauthorized?: () => void;
}

export function createTaskApi(baseUrl: string, optionsOrFetch?: typeof fetch | ApiClientOptions): TaskApiClient;
export function createAiApi(baseUrl: string, optionsOrFetch?: typeof fetch | ApiClientOptions): AiApiClient;
export function getProviderPath(provider: string): string;
export function getExamplesByQuadrantPath(quadrant: number, limit?: number): string;
export function getClassifyPath(title: string, includeSimilarExamples?: boolean): string;
export function getAnalyzeTaskPath(task: string, language?: string): string;
/** @deprecated Use getAnalyzeTaskPath. */
export function getAnalyzeWithLangChainPath(task: string, language?: string): string;
export function getClearTrainingDataPath(keepDefaults?: boolean): string;
export function isTaskDto(value: unknown): value is TaskDto;
export function isHealthResponseDto(value: unknown): value is HealthResponseDto;
export function isClassificationResultDto(value: unknown): value is ClassificationResultDto;
export function isTaskAnalysisDto(value: unknown): value is TaskAnalysisDto;
/** @deprecated Use isTaskAnalysisDto. */
export function isLangChainAnalysisDto(value: unknown): value is LangChainAnalysisDto;
export function isBatchAnalysisResultDto(value: unknown): value is BatchAnalysisResultDto;
export function isOcrResultDto(value: unknown): value is OcrResultDto;
