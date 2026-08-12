export interface TaskDto {
  _id: string;
  title: string;
  description: string;
  urgent: boolean;
  important: boolean;
  lifecycleState: TaskLifecycleState;
  schedule?: TaskScheduleDto;
  delegation?: TaskDelegationDto;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type TaskLifecycleState = 'active' | 'completed' | 'archived' | 'trashed';
export type TaskLifecycleFilter = TaskLifecycleState | 'all';
export type TaskLifecycleAction = 'complete' | 'reopen' | 'archive' | 'trash' | 'restore';

export interface TaskScheduleDto {
  dueAt: string;
  timeZone: string;
  remindAt?: string;
}

export type TaskDelegationStatus =
  'offered' | 'accepted' | 'in_progress' | 'blocked' | 'completed' | 'declined';

export interface TaskDelegationAssignmentDto {
  assigneeUserId: string;
  displayLabel: string;
  handoffNote: string;
}

export interface TaskDelegationDto extends TaskDelegationAssignmentDto {
  status: TaskDelegationStatus;
  offeredAt: string;
  statusUpdatedAt: string;
  acceptedAt?: string;
  inProgressAt?: string;
  blockedAt?: string;
  completedAt?: string;
  declinedAt?: string;
}

export interface TaskInputDto {
  title: string;
  description: string;
  urgent: boolean;
  important: boolean;
}

export interface CalendarStatusDto {
  status: 'disconnected' | 'connected' | 'pending';
  connection: null | { id: string; provider: 'google'; calendarId: string };
  syncState?: Record<string, unknown> | null;
  openConflicts?: number;
  pendingOutbox?: number;
}

export interface CalendarConflictDto {
  _id: string;
  taskId: string;
  providerSnapshot: { title: string; dueAt: string; timeZone: string };
  status: 'open' | 'resolved_local' | 'resolved_provider';
  revision: number;
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
export type Quadrant = 0 | 1 | 2 | 3;

export interface HealthResponseDto {
  status: 'ok' | 'ready' | 'not_ready';
}

export interface ClassificationResultDto {
  task: string;
  urgent: boolean;
  important: boolean;
  quadrant: Quadrant;
  quadrant_name: QuadrantDefinition['name'];
  timestamp: string;
  method: string;
  confidence?: number;
  confidence_calibrated?: boolean;
  requires_confirmation?: boolean;
  confidence_status?: 'accepted' | 'low';
  local_scores: Record<string, number>;
  similar_examples_used: number;
  top_similar_examples: SimilarExampleResultDto[];
}

export interface SimilarExampleResultDto {
  text: string;
  quadrant: Quadrant;
  quadrant_name: QuadrantDefinition['name'];
  source: string;
  score: number;
}

export interface TaskAnalysisDto {
  task: string;
  /** Legacy wire key retained until the server contract is versioned. */
  langchain_analysis: {
    quadrant: Quadrant | null;
    reasoning: string;
    confidence: number;
    method: string;
  };
  /** Legacy wire key retained until the server contract is versioned. */
  rag_classification: {
    quadrant: Quadrant;
    quadrant_name: string;
    confidence: number;
    confidence_calibrated?: boolean;
    requires_confirmation?: boolean;
    confidence_status?: 'accepted' | 'low';
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
  quadrant: Quadrant | null;
  quadrant_name: QuadrantDefinition['name'] | null;
  confidence: number | null;
  explanation: string;
  citations: CitationDto[];
  retrieval: {
    hit_count: number;
    top_score: number | null;
    embedding_version: string | null;
  };
  fallback_reason?: string | null;
  generation?: GenerationMetadataDto | null;
  information_delta?: InformationDeltaDto | null;
}

export interface GenerationMetadataDto {
  execution_id: string;
  prompt_id: string;
  prompt_version: string;
  model_id: string;
  model_revision: string;
  schema_version: string;
  language: 'pl' | 'en';
  input_tokens: number;
}

export interface InformationDeltaClaimDto {
  claim_id: string;
  statement: string;
  relation: 'new_information' | 'confirmation' | 'contradiction' | 'update' | 'necessary_reminder';
  compared_to_statement_ids: string[];
  citation_ids: string[];
  reminder_reason?: 'direct_answer' | 'decision_constraint' | 'safety_constraint' | null;
}

export interface InformationDeltaDto {
  status:
    | 'new_information'
    | 'mixed'
    | 'confirmation_only'
    | 'no_new_information'
    | 'freshness_unverified';
  claims: InformationDeltaClaimDto[];
  summary_code:
    | 'grounded_delta_available'
    | 'known_information_only'
    | 'no_new_information'
    | 'current_world_freshness_unverified';
  world_freshness: 'frozen_corpus_snapshot_not_current_world';
}

export interface KnowledgeSearchDto {
  query: string;
  answer: string | null;
  citations: CitationDto[];
  retrieval: GroundedAnalysisDto['retrieval'];
  no_answer_reason?: string | null;
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
    quadrant: Quadrant;
    quadrant_name: string;
    confidence: number;
    confidence_calibrated?: boolean;
    requires_confirmation?: boolean;
    confidence_status?: 'accepted' | 'low';
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
        quadrant: Quadrant;
        confidence: number;
        quadrant_name: string;
        confidence_calibrated?: boolean;
        requires_confirmation?: boolean;
        confidence_status?: 'accepted' | 'low';
      };
      langchain: {
        quadrant: Quadrant | null;
        confidence: number;
        reasoning: string;
        method: string;
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
  quadrant_names: Record<string, string>;
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
  knowledge_retrieval?: boolean;
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
  device: {
    type: string;
    name: string;
    vendor: string;
    runtime: string;
    runtime_version: string | null;
    torch_device: string;
    count: number;
    cuda_version: string | null;
    accelerated: boolean;
  };
}

export interface TrainingDataClearResultDto {
  message: string;
  remaining_examples: number;
}

export interface TrainingExampleDto {
  text: string;
  quadrant: Quadrant;
  source: string;
  timestamp?: string;
}

export interface TrainingExampleAddedDto {
  message: string;
  example: TrainingExampleDto;
}

export interface FeedbackResultDto {
  message: string;
  predicted_quadrant: Quadrant;
  correct_quadrant: Quadrant;
  example: TrainingExampleDto;
}

export interface RetrainResultDto {
  message: string;
  preserve_experience: boolean;
  preserve_experience_deprecated?: boolean;
  status: 'completed' | 'rejected';
  [key: string]: unknown;
}

export interface OcrFeedbackResultDto {
  examples_added: number;
  retrained: boolean;
  message?: string;
  source?: string;
  pending_review?: boolean;
  training?: RetrainResultDto;
}

export interface ExamplesByQuadrantDto {
  quadrant: Quadrant;
  quadrant_name: QuadrantDefinition['name'];
  examples: TrainingExampleDto[];
}

export interface AcceptedOcrTaskDto {
  text: string;
  quadrant: Quadrant;
}

export interface AcceptedOcrLearningTaskLike {
  text?: string;
  title?: string;
  quadrant?: Quadrant;
  urgent?: boolean;
  important?: boolean;
}

export const TASK_API_PATHS: {
  readonly tasks: '/tasks';
  readonly delegatedTasks: '/tasks/delegated';
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

export const CALENDAR_API_PATHS: {
  readonly status: '/calendar/status';
  readonly syncRequests: '/calendar/sync-requests';
  readonly conflicts: '/calendar/conflicts';
};

export interface TaskApiClient {
  paths: typeof TASK_API_PATHS;
  listTasks(lifecycle?: TaskLifecycleFilter): Promise<TaskDto[]>;
  listDelegatedTasks(): Promise<TaskDto[]>;
  createTask(task: TaskInputDto, idempotencyKey?: string): Promise<TaskDto>;
  updateTask(id: string, patch: Partial<TaskInputDto>, revision?: number): Promise<TaskDto>;
  transitionTaskLifecycle(
    id: string,
    action: TaskLifecycleAction,
    revision?: number
  ): Promise<TaskDto>;
  updateTaskSchedule(
    id: string,
    schedule: TaskScheduleDto | null,
    revision?: number
  ): Promise<TaskDto>;
  updateTaskDelegation(
    id: string,
    delegation: TaskDelegationAssignmentDto | null,
    revision?: number
  ): Promise<TaskDto>;
  transitionTaskDelegation(
    id: string,
    status: TaskDelegationStatus,
    revision?: number
  ): Promise<TaskDto>;
  deleteTask(id: string, revision?: number): Promise<null>;
  getCalendarStatus(): Promise<CalendarStatusDto>;
  requestCalendarSync(idempotencyKey: string): Promise<{ eventId: string }>;
  listCalendarConflicts(): Promise<CalendarConflictDto[]>;
  resolveCalendarConflict(
    id: string,
    strategy: 'eisenhower' | 'google',
    revision: number,
    idempotencyKey: string
  ): Promise<CalendarConflictDto>;
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
  searchKnowledge(
    query: string,
    projectId?: string | null,
    limit?: number
  ): Promise<KnowledgeSearchDto>;
  extractTasksFromImage(file: unknown): Promise<OcrResultDto>;
  batchAnalyzeTasks(tasks: string[]): Promise<BatchAnalysisResultDto>;
  fetchCapabilities(): Promise<AICapabilitiesDto>;
  fetchTrainingStats(): Promise<TrainingStatsDto>;
  setProviderEnabled(
    provider: AIProviderName,
    enabled: boolean
  ): Promise<{ provider: AIProviderName } & AIProviderControlDto>;
  addTrainingExample(text: string, quadrant: Quadrant): Promise<TrainingExampleAddedDto>;
  learnFromFeedback(
    task: string,
    predictedQuadrant: Quadrant,
    correctQuadrant: Quadrant
  ): Promise<FeedbackResultDto>;
  learnFromAcceptedOcrTasks(
    tasks: AcceptedOcrLearningTaskLike[],
    retrain?: boolean
  ): Promise<OcrFeedbackResultDto>;
  retrainModel(preserveExperience?: boolean): Promise<RetrainResultDto>;
  clearTrainingData(keepDefaults?: boolean): Promise<TrainingDataClearResultDto>;
  getExamplesByQuadrant(quadrant: Quadrant, limit?: number): Promise<ExamplesByQuadrantDto>;
}

export function buildUrl(baseUrl: string, path: string): string;
export function createRequestError(
  message: string,
  details?: { code?: string; status?: number }
): Error & { code?: string; status?: number };
export function readJson<T>(
  response: Response,
  options?: {
    defaultError?: string;
    errorCode?: string;
    validate?: (value: unknown) => boolean;
    invalidResponse?: string;
  }
): Promise<T>;
export function toTaskInputDto(task: Partial<TaskInputDto> & { title: string }): TaskInputDto;
export function toTaskPatchDto(patch: Partial<TaskInputDto>): Partial<TaskInputDto>;
export function resolveTaskQuadrant(task: AcceptedOcrLearningTaskLike): Quadrant;
export function toAcceptedOcrLearningPayload(
  tasks: AcceptedOcrLearningTaskLike[]
): Array<{ task: string; quadrant: Quadrant }>;
export interface ApiClientOptions {
  fetch?: typeof fetch;
  accessToken?: string | (() => string | null);
  adminToken?: string | (() => string | null);
  onUnauthorized?: () => void;
  onAdminUnauthorized?: () => void;
}

export function createTaskApi(
  baseUrl: string,
  optionsOrFetch?: typeof fetch | ApiClientOptions
): TaskApiClient;
export function createAiApi(
  baseUrl: string,
  optionsOrFetch?: typeof fetch | ApiClientOptions
): AiApiClient;
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
