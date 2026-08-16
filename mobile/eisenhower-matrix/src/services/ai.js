import { createAiApi } from '@eisenhower/api-client';
import { mobileConfig } from '../config';
import { clearTokens, getAccessToken } from '../authSession';

function getAiApi() {
  return createAiApi(mobileConfig.aiApiUrl, {
    accessToken: getAccessToken,
    onUnauthorized: clearTokens,
  });
}

export async function suggestTaskQuadrant(title) {
  const data = await getAiApi().classifyTask(title, true);

  return {
    urgent: data.urgent,
    important: data.important,
    source: 'central',
  };
}

export async function analyzeTaskAdvanced(task, language = 'pl', options = {}) {
  return getAiApi().analyzeTask(task, language, options);
}

export async function batchAnalyzeTasks(tasks, options = {}) {
  return getAiApi().batchAnalyzeTasks(tasks, options);
}

export async function fetchAICapabilities() {
  return getAiApi().fetchCapabilities();
}
