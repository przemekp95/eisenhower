import { createAiApi } from '@eisenhower/api-client';
import { mobileConfig } from '../config';

function getAiApi() {
  return createAiApi(mobileConfig.aiApiUrl);
}

export async function suggestTaskQuadrant(title) {
  const data = await getAiApi().classifyTask(title, true);

  return {
    urgent: data.urgent,
    important: data.important,
    source: 'central',
  };
}

export async function analyzeTaskAdvanced(task, language = 'pl') {
  return getAiApi().analyzeWithLangChain(task, language);
}

export async function batchAnalyzeTasks(tasks) {
  return getAiApi().batchAnalyzeTasks(tasks);
}

export async function fetchAICapabilities() {
  return getAiApi().fetchCapabilities();
}

export async function setAIProviderEnabled(provider, enabled) {
  return getAiApi().setProviderEnabled(provider, enabled);
}

export async function fetchTrainingStats() {
  return getAiApi().fetchTrainingStats();
}

export async function addTrainingExample(text, quadrant) {
  return getAiApi().addTrainingExample(text, quadrant);
}

export async function learnFromFeedback(task, predictedQuadrant, correctQuadrant) {
  return getAiApi().learnFromFeedback(task, predictedQuadrant, correctQuadrant);
}

export async function learnFromAcceptedOCRTasks(tasks, retrain = true) {
  return getAiApi().learnFromAcceptedOcrTasks(tasks, retrain);
}

export async function retrainModel(preserveExperience = true) {
  return getAiApi().retrainModel(preserveExperience);
}

export async function clearTrainingData(keepDefaults = true) {
  return getAiApi().clearTrainingData(keepDefaults);
}

export async function getExamplesByQuadrant(quadrant, limit = 10) {
  return getAiApi().getExamplesByQuadrant(quadrant, limit);
}
