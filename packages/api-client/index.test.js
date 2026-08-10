const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AI_API_PATHS,
  QUADRANT_DEFINITIONS,
  createAiApi,
  getAnalyzeTaskPath,
  isTaskAnalysisDto,
} = require('./index');

test('publishes one canonical quadrant contract', () => {
  assert.deepEqual(QUADRANT_DEFINITIONS, [
    { value: 0, key: 'do', name: 'Do Now', urgent: true, important: true },
    { value: 1, key: 'delegate', name: 'Delegate', urgent: true, important: false },
    { value: 2, key: 'schedule', name: 'Schedule', urgent: false, important: true },
    { value: 3, key: 'delete', name: 'Delete', urgent: false, important: false },
  ]);
});

test('offers truthful task-analysis names while preserving the legacy endpoint', async () => {
  const calls = [];
  const request = async (...args) => {
    calls.push(args);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        task: 'triage incident',
        langchain_analysis: { quadrant: 0, reasoning: 'urgent', confidence: 0.9, method: 'local' },
        rag_classification: { quadrant: 0, quadrant_name: 'Do Now', confidence: 0.8 },
        comparison: { methods_agree: true, confidence_difference: 0.1 },
      }),
    };
  };
  const api = createAiApi('http://ai.internal', request);

  const result = await api.analyzeTask('triage incident', 'en');

  assert.equal(
    calls[0][0],
    'http://ai.internal/analyze?task=triage%20incident&language=en'
  );
  assert.equal(AI_API_PATHS.analyzeTask, '/analyze');
  assert.equal(getAnalyzeTaskPath('triage incident'), '/analyze?task=triage%20incident&language=en');
  assert.equal(isTaskAnalysisDto(result), true);
  assert.equal(api.analyzeWithLangChain, api.analyzeTask);
});

test('sends bearer auth and the grounded v2 contract without tenant headers', async () => {
  const calls = [];
  const api = createAiApi('https://api.example.com', {
    accessToken: () => 'access-token',
    fetch: async (...args) => {
      calls.push(args);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          mode: 'fallback',
          quadrant: 2,
          quadrant_name: 'Schedule',
          confidence: 0.7,
          explanation: 'fallback',
          citations: [],
          retrieval: { hit_count: 0, top_score: null, embedding_version: null },
        }),
      };
    },
  });

  await api.analyzeTaskWithRag('roadmap');

  assert.equal(calls[0][0], 'https://api.example.com/v2/ai/analyze');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer access-token');
  assert.equal(calls[0][1].headers['X-Tenant-Id'], undefined);
  assert.deepEqual(JSON.parse(calls[0][1].body), { task: 'roadmap' });
});
