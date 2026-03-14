const TASK_API_PATHS = Object.freeze({
  tasks: '/tasks',
  health: '/health',
  readiness: '/health/ready',
});

const AI_API_PATHS = Object.freeze({
  capabilities: '/capabilities',
  trainingStats: '/training-stats',
  classify: '/classify',
  analyzeWithLangChain: '/analyze-langchain',
  extractTasksFromImage: '/extract-tasks-from-image',
  batchAnalyzeTasks: '/batch-analyze',
  addTrainingExample: '/add-example',
  learnFromFeedback: '/learn-feedback',
  learnFromAcceptedOcrTasks: '/learn-ocr-feedback',
  retrainModel: '/retrain',
  clearTrainingData: '/training-data',
});

function getProviderPath(provider) {
  return `/providers/${encodeURIComponent(provider)}`;
}

function getExamplesByQuadrantPath(quadrant, limit = 10) {
  return `/examples/${encodeURIComponent(String(quadrant))}?limit=${encodeURIComponent(String(limit))}`;
}

function getClassifyPath(title, useRag = true) {
  return `${AI_API_PATHS.classify}?title=${encodeURIComponent(title)}&use_rag=${useRag}`;
}

function getAnalyzeWithLangChainPath(task, language = 'en') {
  return `${AI_API_PATHS.analyzeWithLangChain}?task=${encodeURIComponent(task)}&language=${encodeURIComponent(language)}`;
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
  } = options;

  const canReadJson =
    response?.status !== 204 &&
    typeof response?.json === 'function';
  const payload = canReadJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    throw createRequestError(
      payload?.error || defaultError,
      {
        code: payload?.code || errorCode,
        status: response.status,
      }
    );
  }

  if (response.status === 204) {
    return null;
  }

  return payload;
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
    ...(patch?.description !== undefined ? { description: String(patch.description || '').trim() } : {}),
    ...(patch?.urgent !== undefined ? { urgent: Boolean(patch.urgent) } : {}),
    ...(patch?.important !== undefined ? { important: Boolean(patch.important) } : {}),
  };
}

function resolveTaskQuadrant(task) {
  if (typeof task?.quadrant === 'number') {
    return task.quadrant;
  }

  if (task?.urgent && task?.important) {
    return 0;
  }

  if (task?.urgent) {
    return 1;
  }

  if (task?.important) {
    return 2;
  }

  return 3;
}

function toAcceptedOcrLearningPayload(tasks) {
  return tasks.map((task) => ({
    task: typeof task?.text === 'string' ? task.text : String(task?.title || ''),
    quadrant: resolveTaskQuadrant(task),
  }));
}

function createTaskApi(baseUrl, fetchImpl) {
  const request = resolveFetch(fetchImpl);

  return {
    paths: TASK_API_PATHS,
    async listTasks() {
      const response = await request(buildUrl(baseUrl, TASK_API_PATHS.tasks));
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
      });
    },
    async createTask(task) {
      const response = await request(buildUrl(baseUrl, TASK_API_PATHS.tasks), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toTaskInputDto(task)),
      });
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
      });
    },
    async updateTask(id, patch) {
      const response = await request(buildUrl(baseUrl, `${TASK_API_PATHS.tasks}/${encodeURIComponent(id)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toTaskPatchDto(patch)),
      });
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
      });
    },
    async deleteTask(id) {
      const response = await request(buildUrl(baseUrl, `${TASK_API_PATHS.tasks}/${encodeURIComponent(id)}`), {
        method: 'DELETE',
      });
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
      });
    },
    async getHealth() {
      const response = await request(buildUrl(baseUrl, TASK_API_PATHS.health));
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
      });
    },
    async getReadiness() {
      const response = await request(buildUrl(baseUrl, TASK_API_PATHS.readiness));
      return readJson(response, {
        defaultError: 'Task request failed',
        errorCode: 'task_request_failed',
      });
    },
  };
}

function createAiApi(baseUrl, fetchImpl) {
  const request = resolveFetch(fetchImpl);

  return {
    paths: AI_API_PATHS,
    async classifyTask(title, useRag = true) {
      const response = await request(buildUrl(baseUrl, getClassifyPath(title, useRag)));
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
      });
    },
    async analyzeWithLangChain(task, language = 'en') {
      const response = await request(buildUrl(baseUrl, getAnalyzeWithLangChainPath(task, language)), {
        method: 'POST',
      });
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
      });
    },
    async extractTasksFromImage(file) {
      const formData = new FormData();
      formData.append('file', file);

      const response = await request(buildUrl(baseUrl, AI_API_PATHS.extractTasksFromImage), {
        method: 'POST',
        body: formData,
      });
      return readJson(response, {
        defaultError: 'OCR request failed',
        errorCode: 'ocr_request_failed',
      });
    },
    async batchAnalyzeTasks(tasks) {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.batchAnalyzeTasks), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks }),
      });
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
      });
    },
    async fetchCapabilities() {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.capabilities));
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
      });
    },
    async fetchTrainingStats() {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.trainingStats));
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
      });
    },
    async setProviderEnabled(provider, enabled) {
      const response = await request(buildUrl(baseUrl, getProviderPath(provider)), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: Boolean(enabled) }),
      });
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
      });
    },
    async addTrainingExample(text, quadrant) {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.addTrainingExample), {
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
      });
    },
    async learnFromFeedback(task, predictedQuadrant, correctQuadrant) {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.learnFromFeedback), {
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
      });
    },
    async learnFromAcceptedOcrTasks(tasks, retrain = true) {
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return { examples_added: 0, retrained: false };
      }

      const response = await request(buildUrl(baseUrl, AI_API_PATHS.learnFromAcceptedOcrTasks), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tasks: toAcceptedOcrLearningPayload(tasks),
          retrain,
        }),
      });
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
      });
    },
    async retrainModel(preserveExperience = true) {
      const response = await request(buildUrl(baseUrl, AI_API_PATHS.retrainModel), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          preserve_experience: String(preserveExperience),
        }).toString(),
      });
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
      });
    },
    async clearTrainingData(keepDefaults = true) {
      const response = await request(buildUrl(baseUrl, getClearTrainingDataPath(keepDefaults)), {
        method: 'DELETE',
      });
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
      });
    },
    async getExamplesByQuadrant(quadrant, limit = 10) {
      const response = await request(buildUrl(baseUrl, getExamplesByQuadrantPath(quadrant, limit)));
      return readJson(response, {
        defaultError: 'AI request failed',
        errorCode: 'ai_request_failed',
      });
    },
  };
}

function isTaskDto(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value._id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    typeof value.urgent === 'boolean' &&
    typeof value.important === 'boolean'
  );
}

function isHealthResponseDto(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.status === 'string' &&
    typeof value.timestamp === 'string' &&
    value.services &&
    typeof value.services === 'object' &&
    typeof value.services.database === 'string' &&
    typeof value.services.ai === 'string'
  );
}

function isClassificationResultDto(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.task === 'string' &&
    typeof value.urgent === 'boolean' &&
    typeof value.important === 'boolean' &&
    typeof value.quadrant === 'number' &&
    typeof value.quadrant_name === 'string' &&
    typeof value.method === 'string'
  );
}

function isLangChainAnalysisDto(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.task === 'string' &&
    value.langchain_analysis &&
    typeof value.langchain_analysis.reasoning === 'string' &&
    value.rag_classification &&
    typeof value.rag_classification.quadrant === 'number' &&
    typeof value.rag_classification.quadrant_name === 'string'
  );
}

function isBatchAnalysisResultDto(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray(value.batch_results) &&
    value.summary &&
    typeof value.summary.total_tasks === 'number'
  );
}

function isOcrResultDto(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray(value.classified_tasks) &&
    value.summary &&
    typeof value.summary.total_tasks === 'number'
  );
}

module.exports = {
  AI_API_PATHS,
  TASK_API_PATHS,
  buildUrl,
  createAiApi,
  createRequestError,
  createTaskApi,
  getAnalyzeWithLangChainPath,
  getClassifyPath,
  getClearTrainingDataPath,
  getExamplesByQuadrantPath,
  getProviderPath,
  isBatchAnalysisResultDto,
  isClassificationResultDto,
  isHealthResponseDto,
  isLangChainAnalysisDto,
  isOcrResultDto,
  isTaskDto,
  readJson,
  resolveTaskQuadrant,
  toAcceptedOcrLearningPayload,
  toTaskInputDto,
  toTaskPatchDto,
};
