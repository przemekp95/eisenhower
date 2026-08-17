const TASK_API_PATHS = Object.freeze({
  tasks: '/tasks',
  delegatedTasks: '/tasks/delegated',
  health: '/health',
  readiness: '/health/ready',
});

const CALENDAR_API_PATHS = Object.freeze({
  status: '/calendar/status',
  syncRequests: '/calendar/sync-requests',
  conflicts: '/calendar/conflicts',
  oauthStart: '/calendar/oauth/start',
  oauthDisconnect: '/calendar/oauth/disconnect',
});

const MAX_TASK_LIST_PAGES = 100;
const TASK_LIFECYCLE_STATES = Object.freeze(['active', 'completed', 'archived', 'trashed']);
const TASK_LIFECYCLE_FILTERS = Object.freeze([...TASK_LIFECYCLE_STATES, 'all']);
const TASK_DELEGATION_STATUSES = Object.freeze([
  'offered',
  'accepted',
  'in_progress',
  'blocked',
  'completed',
  'declined',
]);

const QUADRANT_DEFINITIONS = Object.freeze([
  Object.freeze({ value: 0, key: 'do', name: 'Do Now', urgent: true, important: true }),
  Object.freeze({ value: 1, key: 'delegate', name: 'Delegate', urgent: true, important: false }),
  Object.freeze({ value: 2, key: 'schedule', name: 'Schedule', urgent: false, important: true }),
  Object.freeze({ value: 3, key: 'delete', name: 'Delete', urgent: false, important: false }),
]);

const AI_API_PATHS = Object.freeze({
  capabilities: '/capabilities',
  trainingStats: '/training-stats',
  classify: '/classify',
  analyzeTask: '/analyze',
  analyzeWithLangChain: '/analyze-langchain',
  analyzeTaskWithRag: '/v2/ai/analyze',
  knowledgeSearch: '/v2/knowledge/search',
  knowledgeAnswer: '/v2/knowledge/answer',
  memoryPrepare: '/v2/memory/prepare',
  memoryConfirm: '/v2/memory/confirm',
  memoryExport: '/v2/memory/export',
  extractTasksFromImage: '/extract-tasks-from-image',
  batchAnalyzeTasks: '/batch-analyze',
  addTrainingExample: '/add-example',
  learnFromFeedback: '/learn-feedback',
  learnFromAcceptedOcrTasks: '/learn-ocr-feedback',
  retrainModel: '/retrain',
  clearTrainingData: '/training-data',
});

// The server path is retained for backwards compatibility. It is a local task
// analysis endpoint, not proof that LangChain or generative RAG handled a request.
const ANALYZE_TASK_PATH = AI_API_PATHS.analyzeTask;

function getProviderPath(provider) {
  return `/providers/${encodeURIComponent(provider)}`;
}

function getExamplesByQuadrantPath(quadrant, limit = 10) {
  return `/examples/${encodeURIComponent(String(quadrant))}?limit=${encodeURIComponent(String(limit))}`;
}

function getClassifyPath(title, includeSimilarExamples = true) {
  void title;
  void includeSimilarExamples;
  return AI_API_PATHS.classify;
}

function getAnalyzeTaskPath(task, language = 'en') {
  void task;
  void language;
  return ANALYZE_TASK_PATH;
}

function getAnalyzeWithLangChainPath(task, language = 'en') {
  void task;
  void language;
  return AI_API_PATHS.analyzeWithLangChain;
}

function getClearTrainingDataPath(keepDefaults = true) {
  return `${AI_API_PATHS.clearTrainingData}?keep_defaults=${keepDefaults}`;
}

function resolveFetch(fetchImpl) {
  const implementation = fetchImpl ?? globalThis.fetch;

  if (typeof implementation !== 'function') {
    throw new Error('Fetch implementation is required.');
  }

  return implementation;
}

function resolveClientOptions(optionsOrFetch) {
  if (typeof optionsOrFetch === 'function' || optionsOrFetch === undefined) {
    return { fetchImpl: optionsOrFetch };
  }
  return {
    fetchImpl: optionsOrFetch.fetch,
    accessToken: optionsOrFetch.accessToken,
    adminToken: optionsOrFetch.adminToken,
    onUnauthorized: optionsOrFetch.onUnauthorized,
    onAdminUnauthorized: optionsOrFetch.onAdminUnauthorized,
    aiTimeoutMs: optionsOrFetch.aiTimeoutMs,
  };
}

function createAuthorizedRequest(optionsOrFetch, credential = 'access') {
  const options = resolveClientOptions(optionsOrFetch);
  const request = resolveFetch(options.fetchImpl);
  return async (url, init = {}) => {
    const configured = credential === 'admin' ? options.adminToken : options.accessToken;
    const token = typeof configured === 'function' ? configured() : configured;
    const headers = { ...(init.headers || {}) };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const requestInit = { ...init, headers };
    const response =
      !token && Object.keys(init).length === 0 && Object.keys(headers).length === 0
        ? await request(url)
        : await request(url, requestInit);
    if (response.status === 401) {
      if (credential === 'admin') {
        options.onAdminUnauthorized?.();
      } else {
        options.onUnauthorized?.();
      }
    }
    return response;
  };
}

function createRequestError(message, details = {}) {
  const error = new Error(message);

  if (details.code !== undefined) {
    error.code = details.code;
  }

  if (details.status !== undefined) {
    error.status = details.status;
  }

  return error;
}

function createBoundedAiRequest(optionsOrFetch, credential = 'access') {
  const options = resolveClientOptions(optionsOrFetch);
  const request = createAuthorizedRequest(optionsOrFetch, credential);
  const configuredTimeout = Number(options.aiTimeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 8_000;

  return async (url, init = {}) => {
    const controller = new AbortController();
    const callerSignal = init.signal;
    let timedOut = false;
    const cancel = () => controller.abort();

    if (callerSignal?.aborted) {
      cancel();
    } else {
      callerSignal?.addEventListener('abort', cancel, { once: true });
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeoutMs);

    try {
      return await request(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw createRequestError(timedOut ? 'Request timed out' : 'Request cancelled', {
          code: timedOut ? 'request_timeout' : 'request_cancelled',
        });
      }
      throw createRequestError('AI service is unavailable', { code: 'ai_unavailable' });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', cancel);
    }
  };
}

function stripTrailingSlash(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = stripTrailingSlash(baseUrl);

  if (!normalizedBaseUrl) {
    return path;
  }

  return `${normalizedBaseUrl}${path}`;
}

async function readJson(response, options = {}) {
  const {
    defaultError = 'Request failed',
    errorCode = 'request_failed',
    validate,
    invalidResponse = 'The API returned an invalid response',
  } = options;

  const canReadJson = response?.status !== 204 && typeof response?.json === 'function';
  const payload = canReadJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const errorPayload = isErrorResponseDto(payload) ? payload : null;
    throw createRequestError(errorPayload?.error || defaultError, {
      code: errorPayload?.code || errorCode,
      status: response.status,
    });
  }

  const result = response.status === 204 ? null : payload;
  if (typeof validate === 'function' && !validate(result)) {
    throw createRequestError(invalidResponse, {
      code: 'invalid_response',
      status: response.status,
    });
  }

  return result;
}

function toTaskInputDto(task) {
  return {
    title: String(task?.title || '').trim(),
    description: String(task?.description || '').trim(),
    urgent: Boolean(task?.urgent),
    important: Boolean(task?.important),
  };
}

function toTaskPatchDto(patch) {
  return {
    ...(patch?.title !== undefined ? { title: String(patch.title || '').trim() } : {}),
    ...(patch?.description !== undefined
      ? { description: String(patch.description || '').trim() }
      : {}),
    ...(patch?.urgent !== undefined ? { urgent: Boolean(patch.urgent) } : {}),
    ...(patch?.important !== undefined ? { important: Boolean(patch.important) } : {}),
  };
}

function resolveTaskQuadrant(task) {
  if (typeof task?.quadrant === 'number') {
    return task.quadrant;
  }

  return QUADRANT_DEFINITIONS.find(
    (quadrant) =>
      quadrant.urgent === Boolean(task?.urgent) && quadrant.important === Boolean(task?.important)
  ).value;
}

function toAcceptedOcrLearningPayload(tasks) {
  return tasks.map((task) => ({
    task: typeof task?.text === 'string' ? task.text : String(task?.title || ''),
    quadrant: resolveTaskQuadrant(task),
  }));
}

function createTaskApi(baseUrl, optionsOrFetch) {
  const request = createAuthorizedRequest(optionsOrFetch);

  return {
    paths: TASK_API_PATHS,
    async listTasks(lifecycle = 'active') {
      const tasks = [];
      const seenCursors = new Set();
      let cursor;

      if (!TASK_LIFECYCLE_FILTERS.includes(lifecycle)) {
        throw createRequestError('Task lifecycle filter is invalid', { code: 'invalid_request' });
      }

      for (let page = 0; page < MAX_TASK_LIST_PAGES; page += 1) {
        const query = [];
        if (lifecycle !== 'active') {
          query.push(`lifecycle=${encodeURIComponent(lifecycle)}`);
        }
        if (cursor !== undefined) {
          query.push(`cursor=${encodeURIComponent(cursor)}`);
        }
        const path =
          query.length > 0 ? `${TASK_API_PATHS.tasks}?${query.join('&')}` : TASK_API_PATHS.tasks;
        const response = await request(buildUrl(baseUrl, path));
        const pageTasks = await readJson(response, {
          defaultError: 'Task request failed',
          errorCode: 'task_request_failed',
          validate: isTaskListDto,
          invalidResponse: 'Task API returned an invalid response',
        });
        tasks.push(...pageTasks);

        const nextCursor = response?.headers?.get?.('X-Next-Cursor');
        if (!nextCursor) {
          return tasks;
        }
        if (seenCursors.has(nextCursor)) {
          throw createRequestError('Task API returned a repeated pagination cursor', {
            code: 'invalid_response',
            status: response.status,
          });
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      throw createRequestError('Task API pagination exceeded the page limit', {
        code: 'invalid_response',
      });
    },
    async listDelegatedTasks(lifecycle = 'active') {
      if (!TASK_LIFECYCLE_FILTERS.includes(lifecycle)) {
        throw createRequestError('Task lifecycle filter is invalid', { code: 'invalid_request' });
      }
      const path = `${TASK_API_PATHS.delegatedTasks}?lifecycle=${encodeURIComponent(lifecycle)}`;
      const response = await request(buildUrl(baseUrl, path));
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
        validate: isTaskListDto,
        invalidResponse: 'Task API returned an invalid response',
      });
    },
    async createTask(task, idempotencyKey) {
      const idempotencyHeaders = typeof idempotencyKey === 'string' && idempotencyKey.length > 0
        ? { 'Idempotency-Key': idempotencyKey }
        : {};
      const response = await request(buildUrl(baseUrl, TASK_API_PATHS.tasks), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...idempotencyHeaders },
        body: JSON.stringify(toTaskInputDto(task)),
      });
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
        validate: isTaskDto,
        invalidResponse: 'Task API returned an invalid response',
      });
    },
    async updateTask(id, patch, revision) {
      const revisionHeaders =
        Number.isInteger(revision) && revision >= 0 ? { 'If-Match': `"${revision}"` } : {};
      const response = await request(
        buildUrl(baseUrl, `${TASK_API_PATHS.tasks}/${encodeURIComponent(id)}`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...revisionHeaders },
          body: JSON.stringify(toTaskPatchDto(patch)),
        }
      );
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
        validate: isTaskDto,
        invalidResponse: 'Task API returned an invalid response',
      });
    },
    async transitionTaskLifecycle(id, action, revision) {
      const revisionHeaders =
        Number.isInteger(revision) && revision >= 0 ? { 'If-Match': `"${revision}"` } : {};
      const response = await request(
        buildUrl(baseUrl, `${TASK_API_PATHS.tasks}/${encodeURIComponent(id)}/lifecycle`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...revisionHeaders },
          body: JSON.stringify({ action }),
        }
      );
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
        validate: isTaskDto,
        invalidResponse: 'Task API returned an invalid response',
      });
    },
    async updateTaskSchedule(id, schedule, revision) {
      const revisionHeaders =
        Number.isInteger(revision) && revision >= 0 ? { 'If-Match': `"${revision}"` } : {};
      const response = await request(
        buildUrl(baseUrl, `${TASK_API_PATHS.tasks}/${encodeURIComponent(id)}/schedule`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...revisionHeaders },
          body: JSON.stringify({ schedule }),
        }
      );
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
        validate: isTaskDto,
        invalidResponse: 'Task API returned an invalid response',
      });
    },
    async updateTaskDelegation(id, delegation, revision) {
      const revisionHeaders =
        Number.isInteger(revision) && revision >= 0 ? { 'If-Match': `"${revision}"` } : {};
      const response = await request(
        buildUrl(baseUrl, `${TASK_API_PATHS.tasks}/${encodeURIComponent(id)}/delegation`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...revisionHeaders },
          body: JSON.stringify({ delegation }),
        }
      );
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
        validate: isTaskDto,
        invalidResponse: 'Task API returned an invalid response',
      });
    },
    async transitionTaskDelegation(id, status, revision) {
      const revisionHeaders =
        Number.isInteger(revision) && revision >= 0 ? { 'If-Match': `"${revision}"` } : {};
      const response = await request(
        buildUrl(baseUrl, `${TASK_API_PATHS.tasks}/${encodeURIComponent(id)}/delegation/status`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...revisionHeaders },
          body: JSON.stringify({ status }),
        }
      );
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
        validate: isTaskDto,
        invalidResponse: 'Task API returned an invalid response',
      });
    },
    async deleteTask(id, revision) {
      const revisionHeaders =
        Number.isInteger(revision) && revision >= 0 ? { 'If-Match': `"${revision}"` } : {};
      const response = await request(
        buildUrl(baseUrl, `${TASK_API_PATHS.tasks}/${encodeURIComponent(id)}`),
        {
          method: 'DELETE',
          headers: revisionHeaders,
        }
      );
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
        validate: isNullDto,
        invalidResponse: 'Task API returned an invalid response',
      });
    },
    async getCalendarStatus() {
      const response = await request(buildUrl(baseUrl, CALENDAR_API_PATHS.status));
      return readJson(response, {
        defaultError: 'Calendar request failed',
        errorCode: 'calendar_request_failed',
        validate: isCalendarStatusDto,
        invalidResponse: 'Calendar API returned an invalid response',
      });
    },
    async startCalendarConnection(returnPath) {
      const response = await request(buildUrl(baseUrl, CALENDAR_API_PATHS.oauthStart), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnPath }),
      });
      return readJson(response, {
        defaultError: 'Calendar request failed',
        errorCode: 'calendar_request_failed',
        validate: (value) => isRecord(value) && typeof value.authorizationUrl === 'string',
        invalidResponse: 'Calendar API returned an invalid response',
      });
    },
    async disconnectCalendar() {
      const response = await request(buildUrl(baseUrl, CALENDAR_API_PATHS.oauthDisconnect), {
        method: 'POST',
      });
      return readJson(response, {
        defaultError: 'Calendar request failed',
        errorCode: 'calendar_request_failed',
        validate: isNullDto,
        invalidResponse: 'Calendar API returned an invalid response',
      });
    },
    async requestCalendarSync(idempotencyKey) {
      const response = await request(buildUrl(baseUrl, CALENDAR_API_PATHS.syncRequests), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: '{}',
      });
      return readJson(response, {
        defaultError: 'Calendar request failed',
        errorCode: 'calendar_request_failed',
        validate: (value) => isRecord(value) && typeof value.eventId === 'string',
        invalidResponse: 'Calendar API returned an invalid response',
      });
    },
    async listCalendarConflicts() {
      const response = await request(buildUrl(baseUrl, CALENDAR_API_PATHS.conflicts));
      return readJson(response, {
        defaultError: 'Calendar request failed',
        errorCode: 'calendar_request_failed',
        validate: (value) => Array.isArray(value) && value.every(isCalendarConflictDto),
        invalidResponse: 'Calendar API returned an invalid response',
      });
    },
    async resolveCalendarConflict(id, strategy, revision, idempotencyKey) {
      const response = await request(
        buildUrl(baseUrl, `${CALENDAR_API_PATHS.conflicts}/${encodeURIComponent(id)}/resolve`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'If-Match': `"${revision}"`,
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ strategy }),
        }
      );
      return readJson(response, {
        defaultError: 'Calendar request failed',
        errorCode: 'calendar_request_failed',
        validate: isResolvedCalendarConflictDto,
        invalidResponse: 'Calendar API returned an invalid response',
      });
    },
    async getHealth() {
      const response = await request(buildUrl(baseUrl, TASK_API_PATHS.health));
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
        validate: isHealthResponseDto,
        invalidResponse: 'Task API returned an invalid response',
      });
    },
    async getReadiness() {
      const response = await request(buildUrl(baseUrl, TASK_API_PATHS.readiness));
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
        validate: isHealthResponseDto,
        invalidResponse: 'Task API returned an invalid response',
      });
    },
  };
}

function createAiApi(baseUrl, optionsOrFetch) {
  const request = createBoundedAiRequest(optionsOrFetch);
  const adminRequest = createBoundedAiRequest(optionsOrFetch, 'admin');

  const analyzeTask = async (task, language = 'en', requestOptions = {}) => {
    const response = await request(buildUrl(baseUrl, getAnalyzeTaskPath(task, language)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, language }),
      signal: requestOptions.signal,
    });
    return readJson(response, {
      defaultError: 'AI request failed',
      errorCode: 'ai_request_failed',
      validate: isTaskAnalysisDto,
      invalidResponse: 'AI API returned an invalid response',
    });
  };

  return {
    paths: AI_API_PATHS,
    async classifyTask(title, includeSimilarExamples = true) {
      const response = await request(
        buildUrl(baseUrl, getClassifyPath(title, includeSimilarExamples)),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, use_rag: includeSimilarExamples }),
        }
      );
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
        validate: isClassificationResultDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    analyzeTask,
    analyzeWithLangChain: analyzeTask,
    async analyzeTaskWithRag(task, requestOptions = {}) {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.analyzeTaskWithRag), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
        signal: requestOptions.signal,
      });
      return readJson(response, {
        defaultError: 'Grounded AI request failed',
        errorCode: 'rag_request_failed',
        validate: isGroundedAnalysisDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async searchKnowledge(query, projectId = null, limit = 5, requestOptions = {}) {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.knowledgeSearch), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, project_id: projectId, limit }),
        signal: requestOptions.signal,
      });
      return readJson(response, {
        defaultError: 'Knowledge search failed',
        errorCode: 'knowledge_search_failed',
        validate: isKnowledgeSearchDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async answerKnowledge(query, language = 'en', projectId = null, limit = 5, requestOptions = {}) {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.knowledgeAnswer), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, language, project_id: projectId, limit }),
        signal: requestOptions.signal,
      });
      return readJson(response, {
        defaultError: 'Knowledge answer failed',
        errorCode: 'knowledge_answer_failed',
        validate: isKnowledgeAnswerDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async prepareMemory(intent, requestOptions = {}) {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.memoryPrepare), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(intent),
        signal: requestOptions.signal,
      });
      return readJson(response, {
        defaultError: 'Memory preview could not be prepared',
        errorCode: 'memory_prepare_failed',
        validate: isMemoryPrepareResponseDto,
        invalidResponse: 'AI API returned an invalid memory preview',
      });
    },
    async confirmMemory(intent, receipt, idempotencyKey, requestOptions = {}) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        throw createRequestError('A memory confirmation key is required', {
          code: 'memory_idempotency_key_required',
        });
      }
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.memoryConfirm), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ intent, receipt }),
        signal: requestOptions.signal,
      });
      return readJson(response, {
        defaultError: 'Memory confirmation failed',
        errorCode: 'memory_confirm_failed',
        validate: isMemoryConfirmResponseDto,
        invalidResponse: 'AI API returned an invalid memory confirmation',
      });
    },
    async exportMemory(requestOptions = {}) {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.memoryExport), {
        signal: requestOptions.signal,
      });
      return readJson(response, {
        defaultError: 'Memory export failed',
        errorCode: 'memory_export_failed',
        validate: isMemoryExportResponseDto,
        invalidResponse: 'AI API returned an invalid memory export',
      });
    },
    async extractTasksFromImage(file, requestOptions = {}) {
      const formData = new FormData();
      formData.append('file', file);

      const response = await request(buildUrl(baseUrl, AI_API_PATHS.extractTasksFromImage), {
        method: 'POST',
        body: formData,
        signal: requestOptions.signal,
      });
      return readJson(response, {
        defaultError: 'OCR request failed',
        errorCode: 'ocr_request_failed',
        validate: isOcrResultDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async batchAnalyzeTasks(tasks, requestOptions = {}) {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.batchAnalyzeTasks), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks }),
        signal: requestOptions.signal,
      });
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
        validate: isBatchAnalysisResultDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async fetchCapabilities(requestOptions = {}) {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.capabilities), {
        signal: requestOptions.signal,
      });
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
        validate: isCapabilitiesDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async fetchTrainingStats() {
      const response = await adminRequest(buildUrl(baseUrl, AI_API_PATHS.trainingStats));
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
        validate: isTrainingStatsDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async setProviderEnabled(provider, enabled) {
      const response = await adminRequest(buildUrl(baseUrl, getProviderPath(provider)), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: Boolean(enabled) }),
      });
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
        validate: isProviderControlDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async addTrainingExample(text, quadrant) {
      const response = await adminRequest(buildUrl(baseUrl, AI_API_PATHS.addTrainingExample), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          text,
          quadrant: String(quadrant),
        }).toString(),
      });
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
        validate: isTrainingExampleAddedDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async learnFromFeedback(task, predictedQuadrant, correctQuadrant) {
      const response = await adminRequest(buildUrl(baseUrl, AI_API_PATHS.learnFromFeedback), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          task,
          predicted_quadrant: String(predictedQuadrant),
          correct_quadrant: String(correctQuadrant),
        }).toString(),
      });
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
        validate: isFeedbackResultDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async learnFromAcceptedOcrTasks(tasks, retrain = true) {
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return { examples_added: 0, retrained: false };
      }

      const response = await adminRequest(
        buildUrl(baseUrl, AI_API_PATHS.learnFromAcceptedOcrTasks),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tasks: toAcceptedOcrLearningPayload(tasks),
            retrain,
          }),
        }
      );
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
        validate: isOcrFeedbackResultDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async retrainModel(preserveExperience = true) {
      const response = await adminRequest(buildUrl(baseUrl, AI_API_PATHS.retrainModel), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          preserve_experience: String(preserveExperience),
        }).toString(),
      });
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
        validate: isRetrainResultDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async clearTrainingData(keepDefaults = true) {
      const response = await adminRequest(
        buildUrl(baseUrl, getClearTrainingDataPath(keepDefaults)),
        {
          method: 'DELETE',
        }
      );
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
        validate: isTrainingDataClearResultDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
    async getExamplesByQuadrant(quadrant, limit = 10) {
      const response = await adminRequest(
        buildUrl(baseUrl, getExamplesByQuadrantPath(quadrant, limit))
      );
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
        validate: isExamplesByQuadrantDto,
        invalidResponse: 'AI API returned an invalid response',
      });
    },
  };
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isConfidence(value) {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isOptional(value, validate) {
  return value === undefined || validate(value);
}

function isNullable(value, validate) {
  return value === null || validate(value);
}

function isRecordOf(value, validate) {
  return isRecord(value) && Object.values(value).every(validate);
}

function quadrantDefinition(value) {
  return QUADRANT_DEFINITIONS.find((definition) => definition.value === value);
}

function isQuadrant(value) {
  return Boolean(quadrantDefinition(value));
}

function isNullDto(value) {
  return value === null;
}

function isErrorResponseDto(value) {
  return Boolean(
    isRecord(value) &&
    isOptional(value.error, (item) => typeof item === 'string') &&
    isOptional(value.code, (item) => typeof item === 'string')
  );
}

function isTaskDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value._id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    typeof value.urgent === 'boolean' &&
    typeof value.important === 'boolean' &&
    TASK_LIFECYCLE_STATES.includes(value.lifecycleState) &&
    isOptional(value.schedule, isTaskScheduleDto) &&
    isOptional(value.delegation, isTaskDelegationDto) &&
    isOptional(value.revision, isNonNegativeInteger) &&
    isOptional(value.createdAt, (item) => typeof item === 'string') &&
    isOptional(value.updatedAt, (item) => typeof item === 'string')
  );
}

function isCalendarStatusDto(value) {
  if (!isRecord(value) || !['disconnected', 'connected', 'pending'].includes(value.status)) {
    return false;
  }
  if (typeof value.canConnect !== 'boolean') return false;
  if (value.status === 'disconnected') return value.connection === null;
  return Boolean(
    isRecord(value.connection) &&
    typeof value.connection.id === 'string' &&
    value.connection.provider === 'google' &&
    typeof value.connection.calendarId === 'string' &&
    isNonNegativeInteger(value.openConflicts) &&
    isNonNegativeInteger(value.pendingOutbox) &&
    isNonNegativeInteger(value.failedSyncCount) &&
    typeof value.syncProblem === 'boolean' &&
    isOptional(value.syncState, (item) => item === null || isRecord(item))
  );
}

function isCalendarConflictDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value._id === 'string' &&
    typeof value.taskId === 'string' &&
    value.status === 'open' &&
    isNonNegativeInteger(value.revision) &&
    isRecord(value.providerSnapshot) &&
    typeof value.providerSnapshot.title === 'string' &&
    isUtcIsoInstant(value.providerSnapshot.dueAt) &&
    isIanaTimezone(value.providerSnapshot.timeZone)
  );
}

function isResolvedCalendarConflictDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value._id === 'string' &&
    ['resolved_local', 'resolved_provider'].includes(value.status) &&
    isNonNegativeInteger(value.revision)
  );
}

function isUtcIsoInstant(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isIanaTimezone(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isTaskScheduleDto(value) {
  const scheduleFields = new Set(['dueAt', 'timeZone', 'remindAt']);
  return Boolean(
    isRecord(value) &&
    Object.keys(value).every((field) => scheduleFields.has(field)) &&
    isUtcIsoInstant(value.dueAt) &&
    isIanaTimezone(value.timeZone) &&
    isOptional(
      value.remindAt,
      (item) => isUtcIsoInstant(item) && Date.parse(item) <= Date.parse(value.dueAt)
    )
  );
}

function isTaskDelegationDto(value) {
  const fields = new Set([
    'assigneeUserId',
    'displayLabel',
    'handoffNote',
    'status',
    'offeredAt',
    'statusUpdatedAt',
    'acceptedAt',
    'inProgressAt',
    'blockedAt',
    'completedAt',
    'declinedAt',
  ]);
  return Boolean(
    isRecord(value) &&
    Object.keys(value).every((field) => fields.has(field)) &&
    typeof value.assigneeUserId === 'string' &&
    value.assigneeUserId.length > 0 &&
    typeof value.displayLabel === 'string' &&
    value.displayLabel.length > 0 &&
    typeof value.handoffNote === 'string' &&
    TASK_DELEGATION_STATUSES.includes(value.status) &&
    isUtcIsoInstant(value.offeredAt) &&
    isUtcIsoInstant(value.statusUpdatedAt) &&
    isOptional(value.acceptedAt, isUtcIsoInstant) &&
    isOptional(value.inProgressAt, isUtcIsoInstant) &&
    isOptional(value.blockedAt, isUtcIsoInstant) &&
    isOptional(value.completedAt, isUtcIsoInstant) &&
    isOptional(value.declinedAt, isUtcIsoInstant)
  );
}

function isTaskListDto(value) {
  return Array.isArray(value) && value.every(isTaskDto);
}

function isHealthResponseDto(value) {
  return Boolean(isRecord(value) && ['ok', 'ready', 'not_ready'].includes(value.status));
}

function isClassificationResultDto(value) {
  const expected = quadrantDefinition(value?.quadrant);
  return Boolean(
    isRecord(value) &&
    expected &&
    typeof value.task === 'string' &&
    value.urgent === expected.urgent &&
    value.important === expected.important &&
    value.quadrant_name === expected.name &&
    typeof value.timestamp === 'string' &&
    typeof value.method === 'string' &&
    isOptional(value.confidence, isConfidence) &&
    isOptional(value.confidence_calibrated, (item) => typeof item === 'boolean') &&
    isOptional(value.requires_confirmation, (item) => typeof item === 'boolean') &&
    isOptional(value.confidence_status, (item) => ['accepted', 'low'].includes(item)) &&
    isRecordOf(value.local_scores, isFiniteNumber) &&
    isNonNegativeInteger(value.similar_examples_used) &&
    Array.isArray(value.top_similar_examples) &&
    value.top_similar_examples.every(isSimilarExampleResultDto)
  );
}

function isAnalysisMethodDto(value) {
  return Boolean(
    isRecord(value) &&
    isNullable(value.quadrant, isQuadrant) &&
    typeof value.reasoning === 'string' &&
    isConfidence(value.confidence) &&
    typeof value.method === 'string'
  );
}

function isRagClassificationDto(value) {
  return Boolean(
    isRecord(value) &&
    isQuadrant(value.quadrant) &&
    typeof value.quadrant_name === 'string' &&
    isConfidence(value.confidence) &&
    isOptional(value.confidence_calibrated, (item) => typeof item === 'boolean') &&
    isOptional(value.requires_confirmation, (item) => typeof item === 'boolean') &&
    isOptional(value.confidence_status, (item) => ['accepted', 'low'].includes(item))
  );
}

function isTaskAnalysisDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.task === 'string' &&
    isAnalysisMethodDto(value.langchain_analysis) &&
    isRagClassificationDto(value.rag_classification) &&
    isRecord(value.comparison) &&
    typeof value.comparison.methods_agree === 'boolean' &&
    isFiniteNumber(value.comparison.confidence_difference) &&
    isOptional(value.timestamp, (item) => typeof item === 'string')
  );
}

const isLangChainAnalysisDto = isTaskAnalysisDto;

function isCitationDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.chunk_id === 'string' &&
    typeof value.document_id === 'string' &&
    typeof value.source_uri === 'string' &&
    typeof value.title === 'string' &&
    typeof value.excerpt === 'string' &&
    isFiniteNumber(value.score) &&
    typeof value.content_version === 'string'
  );
}

function isRetrievalSummaryDto(value) {
  return Boolean(
    isRecord(value) &&
    isNonNegativeInteger(value.hit_count) &&
    isNullable(value.top_score, isFiniteNumber) &&
    isNullable(value.embedding_version, (item) => typeof item === 'string')
  );
}

function isGenerationMetadataDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.execution_id === 'string' &&
    typeof value.prompt_id === 'string' &&
    typeof value.prompt_version === 'string' &&
    typeof value.model_id === 'string' &&
    typeof value.model_revision === 'string' &&
    typeof value.schema_version === 'string' &&
    ['pl', 'en'].includes(value.language) &&
    isNonNegativeInteger(value.input_tokens)
  );
}

function isInformationDeltaClaimDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.claim_id === 'string' &&
    typeof value.statement === 'string' &&
    ['new_information', 'confirmation', 'contradiction', 'update', 'necessary_reminder'].includes(
      value.relation
    ) &&
    Array.isArray(value.compared_to_statement_ids) &&
    value.compared_to_statement_ids.every((item) => typeof item === 'string') &&
    Array.isArray(value.citation_ids) &&
    value.citation_ids.every((item) => typeof item === 'string') &&
    isOptional(
      value.reminder_reason,
      (item) =>
        item === null ||
        ['direct_answer', 'decision_constraint', 'safety_constraint'].includes(item)
    )
  );
}

function isInformationDeltaDto(value) {
  return Boolean(
    isRecord(value) &&
    [
      'new_information',
      'mixed',
      'confirmation_only',
      'no_new_information',
      'freshness_unverified',
    ].includes(value.status) &&
    Array.isArray(value.claims) &&
    value.claims.every(isInformationDeltaClaimDto) &&
    [
      'grounded_delta_available',
      'known_information_only',
      'no_new_information',
      'current_world_freshness_unverified',
    ].includes(value.summary_code) &&
    value.world_freshness === 'frozen_corpus_snapshot_not_current_world'
  );
}

function isGroundedAnalysisDto(value) {
  const expected = quadrantDefinition(value?.quadrant);
  return Boolean(
    isRecord(value) &&
    ['rag', 'fallback', 'no_answer'].includes(value.mode) &&
    isNullable(value.quadrant, isQuadrant) &&
    ((value.quadrant === null && value.quadrant_name === null) ||
      (expected && value.quadrant_name === expected.name)) &&
    isNullable(value.confidence, isConfidence) &&
    typeof value.explanation === 'string' &&
    Array.isArray(value.citations) &&
    value.citations.every(isCitationDto) &&
    isRetrievalSummaryDto(value.retrieval) &&
    isOptional(value.fallback_reason, (item) =>
      isNullable(item, (entry) => typeof entry === 'string')
    ) &&
    isOptional(value.generation, (item) => isNullable(item, isGenerationMetadataDto)) &&
    isOptional(value.information_delta, (item) => isNullable(item, isInformationDeltaDto))
  );
}

function isKnowledgeSearchDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.query === 'string' &&
    isNullable(value.answer, (item) => typeof item === 'string') &&
    Array.isArray(value.citations) &&
    value.citations.every(isCitationDto) &&
    isRetrievalSummaryDto(value.retrieval) &&
    isOptional(value.no_answer_reason, (item) =>
      isNullable(item, (entry) => typeof entry === 'string')
    )
  );
}

function isKnowledgeAnswerClaimDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.statement === 'string' &&
    Array.isArray(value.citation_ids) &&
    value.citation_ids.length > 0 &&
    value.citation_ids.every((item) => typeof item === 'string')
  );
}

function isKnowledgeAnswerDto(value) {
  if (
    !isRecord(value) ||
    !['answered', 'insufficient_evidence'].includes(value.status) ||
    !Array.isArray(value.claims) ||
    !value.claims.every(isKnowledgeAnswerClaimDto) ||
    !Array.isArray(value.citations) ||
    !value.citations.every(isCitationDto) ||
    !isRetrievalSummaryDto(value.retrieval) ||
    !isOptional(value.generation, (item) => isNullable(item, isGenerationMetadataDto)) ||
    !isOptional(value.no_answer_reason, (item) =>
      isNullable(item, (entry) => typeof entry === 'string')
    )
  ) return false;
  if (value.status === 'answered') {
    return typeof value.answer === 'string' && value.answer.length > 0 && value.claims.length > 0;
  }
  return value.answer === null && value.claims.length === 0 && value.citations.length === 0;
}

function isSimilarExampleResultDto(value) {
  const expected = quadrantDefinition(value?.quadrant);
  return Boolean(
    isRecord(value) &&
    expected &&
    typeof value.text === 'string' &&
    value.quadrant_name === expected.name &&
    typeof value.source === 'string' &&
    isFiniteNumber(value.score)
  );
}

function isOcrClassifiedTaskDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.text === 'string' &&
    isQuadrant(value.quadrant) &&
    typeof value.quadrant_name === 'string' &&
    isConfidence(value.confidence) &&
    isOptional(value.confidence_calibrated, (item) => typeof item === 'boolean') &&
    isOptional(value.requires_confirmation, (item) => typeof item === 'boolean') &&
    isOptional(value.confidence_status, (item) => ['accepted', 'low'].includes(item)) &&
    isOptional(value.similar_examples_used, isNonNegativeInteger) &&
    isOptional(
      value.top_similar_examples,
      (items) => Array.isArray(items) && items.every(isSimilarExampleResultDto)
    )
  );
}

function isOcrResultDto(value) {
  const distribution = value?.summary?.quadrant_distribution;
  return Boolean(
    isRecord(value) &&
    typeof value.filename === 'string' &&
    isRecord(value.image_info) &&
    isNonNegativeInteger(value.image_info.size_bytes) &&
    typeof value.image_info.shape === 'string' &&
    isRecord(value.ocr) &&
    typeof value.ocr.extracted_text === 'string' &&
    isNonNegativeInteger(value.ocr.raw_tasks_detected) &&
    typeof value.ocr.method === 'string' &&
    Array.isArray(value.classified_tasks) &&
    value.classified_tasks.every(isOcrClassifiedTaskDto) &&
    isRecord(value.summary) &&
    isNonNegativeInteger(value.summary.total_tasks) &&
    isRecord(distribution) &&
    isRecordOf(distribution.counts, isNonNegativeInteger) &&
    isRecordOf(distribution.percentages, isFiniteNumber) &&
    isRecordOf(distribution.quadrant_names, (item) => typeof item === 'string') &&
    isOptional(value.timestamp, (item) => typeof item === 'string')
  );
}

function isBatchAnalysisResultDto(value) {
  return Boolean(
    isRecord(value) &&
    Array.isArray(value.batch_results) &&
    value.batch_results.every(
      (item) =>
        isRecord(item) &&
        typeof item.task === 'string' &&
        isRecord(item.analyses) &&
        isRagClassificationDto(item.analyses.rag) &&
        isAnalysisMethodDto(item.analyses.langchain)
    ) &&
    isRecord(value.summary) &&
    isRecordOf(
      value.summary.methods,
      (item) => isRecord(item) && isRecordOf(item.quadrant_distribution, isNonNegativeInteger)
    ) &&
    isNonNegativeInteger(value.summary.total_tasks) &&
    isOptional(value.timestamp, (item) => typeof item === 'string')
  );
}

function isProviderStateDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    typeof value.available === 'boolean' &&
    typeof value.active === 'boolean' &&
    isOptional(value.reason, (item) => isNullable(item, (entry) => typeof entry === 'string'))
  );
}

function isCapabilitiesDto(value) {
  const fields = new Set([
    'classification',
    'reasoned_local_analysis',
    'retrieval_augmented_generation',
    'knowledge_retrieval',
    'local_similar_examples',
    'ocr',
    'batch_analysis',
  ]);
  const optionalFields = new Set(['memory_write', 'memory_retrieval', 'memory_response']);
  return Boolean(
    isRecord(value) &&
    Object.keys(value).every((field) => fields.has(field) || optionalFields.has(field)) &&
    [...fields].every((field) => Object.hasOwn(value, field)) &&
    typeof value.classification === 'boolean' &&
    typeof value.reasoned_local_analysis === 'boolean' &&
    typeof value.retrieval_augmented_generation === 'boolean' &&
    typeof value.knowledge_retrieval === 'boolean' &&
    typeof value.local_similar_examples === 'boolean' &&
    typeof value.ocr === 'boolean' &&
    typeof value.batch_analysis === 'boolean' &&
    isOptional(value.memory_write, (item) => typeof item === 'boolean') &&
    isOptional(value.memory_retrieval, (item) => typeof item === 'boolean') &&
    isOptional(value.memory_response, (item) => typeof item === 'boolean')
  );
}

function isMemoryConsentReceipt(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.confirmation_id === 'string' &&
    typeof value.actor_user_id === 'string' &&
    ['create', 'supersede', 'revoke', 'delete'].includes(value.action) &&
    typeof value.intent_checksum === 'string' &&
    /^[a-f0-9]{64}$/.test(value.intent_checksum) &&
    typeof value.policy_version === 'string' &&
    isUtcIsoInstant(value.confirmed_at) &&
    isUtcIsoInstant(value.expires_at) &&
    Date.parse(value.expires_at) > Date.parse(value.confirmed_at)
  );
}

function isMemoryPrepareResponseDto(value) {
  return Boolean(
    isRecord(value) &&
    ['create', 'supersede', 'revoke', 'delete'].includes(value.action) &&
    typeof value.memory_id === 'string' &&
    isMemoryConsentReceipt(value.receipt) &&
    value.receipt.action === value.action
  );
}

function isMemoryConfirmResponseDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.memory_id === 'string' &&
    ['active', 'superseded', 'consent_revoked', 'deleted'].includes(value.status) &&
    ['synchronized', 'pending', 'not_configured'].includes(value.projection_state)
  );
}

function isMemoryExportItemDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.memory_id === 'string' &&
    typeof value.memory_type === 'string' &&
    typeof value.conflict_key === 'string' &&
    typeof value.content === 'string' &&
    typeof value.provenance === 'string' &&
    isConfidence(value.confidence) &&
    isConfidence(value.salience) &&
    typeof value.retention_class === 'string' &&
    isUtcIsoInstant(value.created_at) &&
    isUtcIsoInstant(value.updated_at) &&
    isUtcIsoInstant(value.expires_at) &&
    ['active', 'superseded', 'consent_revoked', 'deleted'].includes(value.status) &&
    isNullable(value.supersedes_id, (item) => typeof item === 'string') &&
    isNullable(value.superseded_by_id, (item) => typeof item === 'string') &&
    ['create', 'supersede', 'revoke', 'delete'].includes(value.consent_action) &&
    typeof value.consent_policy_version === 'string' &&
    isUtcIsoInstant(value.consented_at)
  );
}

function isMemoryExportResponseDto(value) {
  return Boolean(
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isMemoryExportItemDto)
  );
}

function isTrainingStatsDto(value) {
  return Boolean(
    isRecord(value) &&
    isNonNegativeInteger(value.total_examples) &&
    isRecordOf(value.quadrant_distribution, isNonNegativeInteger) &&
    isRecordOf(value.data_sources, isNonNegativeInteger) &&
    typeof value.data_file === 'string' &&
    typeof value.model_file === 'string' &&
    typeof value.last_updated === 'string' &&
    isRecordOf(value.quadrant_names, (item) => typeof item === 'string') &&
    isOptional(value.model_name, (item) => typeof item === 'string') &&
    isOptional(value.model_ready, (item) => typeof item === 'boolean') &&
    isOptional(value.model_encoder, (item) => typeof item === 'string') &&
    isOptional(value.model_trained_at, (item) =>
      isNullable(item, (entry) => typeof entry === 'string')
    ) &&
    isOptional(value.model_validation_skipped, (item) => typeof item === 'boolean') &&
    isOptional(value.model_error, (item) => isNullable(item, (entry) => typeof entry === 'string'))
  );
}

function isProviderControlDto(value) {
  return Boolean(
    isProviderStateDto(value) && ['local_model', 'tesseract'].includes(value.provider)
  );
}

function isTrainingExampleDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.text === 'string' &&
    isQuadrant(value.quadrant) &&
    typeof value.source === 'string' &&
    isOptional(value.timestamp, (item) => typeof item === 'string')
  );
}

function isTrainingExampleAddedDto(value) {
  return Boolean(
    isRecord(value) && typeof value.message === 'string' && isTrainingExampleDto(value.example)
  );
}

function isFeedbackResultDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.message === 'string' &&
    isQuadrant(value.predicted_quadrant) &&
    isQuadrant(value.correct_quadrant) &&
    isTrainingExampleDto(value.example)
  );
}

function isOcrFeedbackResultDto(value) {
  return Boolean(
    isRecord(value) &&
    isNonNegativeInteger(value.examples_added) &&
    typeof value.retrained === 'boolean' &&
    isOptional(value.message, (item) => typeof item === 'string') &&
    isOptional(value.source, (item) => typeof item === 'string') &&
    isOptional(value.pending_review, (item) => typeof item === 'boolean') &&
    isOptional(value.training, isRetrainResultDto)
  );
}

function isRetrainResultDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.message === 'string' &&
    typeof value.preserve_experience === 'boolean' &&
    isOptional(value.preserve_experience_deprecated, (item) => typeof item === 'boolean') &&
    ['completed', 'rejected'].includes(value.status)
  );
}

function isTrainingDataClearResultDto(value) {
  return Boolean(
    isRecord(value) &&
    typeof value.message === 'string' &&
    isNonNegativeInteger(value.remaining_examples)
  );
}

function isExamplesByQuadrantDto(value) {
  const expected = quadrantDefinition(value?.quadrant);
  return Boolean(
    isRecord(value) &&
    expected &&
    value.quadrant_name === expected.name &&
    Array.isArray(value.examples) &&
    value.examples.every(isTrainingExampleDto)
  );
}

module.exports = {
  AI_API_PATHS,
  CALENDAR_API_PATHS,
  QUADRANT_DEFINITIONS,
  TASK_API_PATHS,
  buildUrl,
  createAiApi,
  createRequestError,
  createTaskApi,
  getAnalyzeWithLangChainPath,
  getAnalyzeTaskPath,
  getClassifyPath,
  getClearTrainingDataPath,
  getExamplesByQuadrantPath,
  getProviderPath,
  isBatchAnalysisResultDto,
  isClassificationResultDto,
  isHealthResponseDto,
  isLangChainAnalysisDto,
  isTaskAnalysisDto,
  isOcrResultDto,
  isTaskDto,
  readJson,
  resolveTaskQuadrant,
  toAcceptedOcrLearningPayload,
  toTaskInputDto,
  toTaskPatchDto,
};
