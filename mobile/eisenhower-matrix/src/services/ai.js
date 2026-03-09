import { mobileConfig } from '../config';

function createAIError(message, code = 'ai_request_failed', status = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function readJson(response) {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw createAIError(
      payload?.error || 'AI request failed',
      payload?.code || 'ai_request_failed',
      response.status
    );
  }

  return payload;
}

function resolveTaskQuadrant(task) {
  if (task.urgent && task.important) {
    return 0;
  }
  if (task.urgent) {
    return 1;
  }
  if (task.important) {
    return 2;
  }
  return 3;
}

export async function suggestTaskQuadrant(title) {
  const response = await fetch(
    `${mobileConfig.aiApiUrl}/classify?title=${encodeURIComponent(title)}&use_rag=true`
  );
  const data = await readJson(response);

  return {
    urgent: data.urgent,
    important: data.important,
    source: 'central',
  };
}

export async function analyzeTaskAdvanced(task, language = 'pl') {
  const response = await fetch(
    `${mobileConfig.aiApiUrl}/analyze-langchain?task=${encodeURIComponent(task)}&language=${language}`,
    { method: 'POST' }
  );

  return readJson(response);
}

export async function batchAnalyzeTasks(tasks) {
  const response = await fetch(`${mobileConfig.aiApiUrl}/batch-analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks }),
  });

  return readJson(response);
}

export async function fetchAICapabilities() {
  const response = await fetch(`${mobileConfig.aiApiUrl}/capabilities`);
  return readJson(response);
}

export async function setAIProviderEnabled(provider, enabled) {
  const response = await fetch(`${mobileConfig.aiApiUrl}/providers/${provider}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: Boolean(enabled) }),
  });

  return readJson(response);
}

export async function fetchTrainingStats() {
  const response = await fetch(`${mobileConfig.aiApiUrl}/training-stats`);
  return readJson(response);
}

export async function addTrainingExample(text, quadrant) {
  const response = await fetch(`${mobileConfig.aiApiUrl}/add-example`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      text,
      quadrant: String(quadrant),
    }).toString(),
  });

  return readJson(response);
}

export async function learnFromFeedback(task, predictedQuadrant, correctQuadrant) {
  const response = await fetch(`${mobileConfig.aiApiUrl}/learn-feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      task,
      predicted_quadrant: String(predictedQuadrant),
      correct_quadrant: String(correctQuadrant),
    }).toString(),
  });

  return readJson(response);
}

export async function learnFromAcceptedOCRTasks(tasks, retrain = true) {
  if (!tasks.length) {
    return { examples_added: 0, retrained: false };
  }

  const response = await fetch(`${mobileConfig.aiApiUrl}/learn-ocr-feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tasks: tasks.map((task) => ({ task: task.title, quadrant: resolveTaskQuadrant(task) })),
      retrain,
    }),
  });

  return readJson(response);
}

export async function retrainModel(preserveExperience = true) {
  const response = await fetch(`${mobileConfig.aiApiUrl}/retrain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      preserve_experience: String(preserveExperience),
    }).toString(),
  });

  return readJson(response);
}

export async function clearTrainingData(keepDefaults = true) {
  const response = await fetch(`${mobileConfig.aiApiUrl}/training-data?keep_defaults=${keepDefaults}`, {
    method: 'DELETE',
  });

  return readJson(response);
}

export async function getExamplesByQuadrant(quadrant, limit = 10) {
  const response = await fetch(`${mobileConfig.aiApiUrl}/examples/${quadrant}?limit=${limit}`);
  return readJson(response);
}
