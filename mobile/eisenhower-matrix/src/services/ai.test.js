import { setAccessToken } from '../authSession';
import { mobileConfig } from '../config';
import {
  analyzeTaskAdvanced,
  batchAnalyzeTasks,
  fetchAICapabilities,
  suggestTaskQuadrant,
} from './ai';

describe('business task-assistance service', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    setAccessToken('test-api-token');
  });

  it('requests a task suggestion with the runtime access credential only', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        task: 'Call customer',
        quadrant: 1,
        quadrant_name: 'Delegate',
        urgent: true,
        important: false,
        confidence: 0.9,
        timestamp: '2026-08-16T10:00:00.000Z',
        method: 'business-classifier',
        local_scores: { 0: 0.1, 1: 0.9, 2: 0, 3: 0 },
        similar_examples_used: 0,
        top_similar_examples: [],
      }),
    });

    await expect(suggestTaskQuadrant('Call customer')).resolves.toEqual({
      urgent: true,
      important: false,
      source: 'central',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/classify`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-api-token' }),
      })
    );
    expect(global.fetch.mock.calls[0][1].headers).not.toHaveProperty('X-Admin-Token');
  });

  it('preserves a business operation error returned by task assistance', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: 'Task suggestions are unavailable.', code: 'provider_disabled' }),
    });

    await expect(suggestTaskQuadrant('Call customer')).rejects.toMatchObject({
      status: 503,
      code: 'provider_disabled',
    });
  });

  it('runs single-task and bulk review through business endpoints', async () => {
    const responses = [
      {
        task: 'Plan roadmap',
        langchain_analysis: { quadrant: 2, reasoning: 'Plan it.', confidence: 0.9, method: 'analysis' },
        rag_classification: { quadrant: 2, quadrant_name: 'Schedule', confidence: 0.8 },
        comparison: { methods_agree: true, confidence_difference: 0.1 },
      },
      {
        batch_results: [],
        summary: { methods: { rag: { quadrant_distribution: {} } }, total_tasks: 2 },
      },
    ];
    global.fetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => responses.shift(),
    }));

    await analyzeTaskAdvanced('Plan roadmap', 'pl');
    await batchAnalyzeTasks(['A', 'B']);

    expect(global.fetch.mock.calls[0][0]).toBe(`${mobileConfig.aiApiUrl}/analyze`);
    expect(global.fetch.mock.calls[0][1].body).toBe(
      JSON.stringify({ task: 'Plan roadmap', language: 'pl' })
    );
    expect(global.fetch.mock.calls[1][0]).toBe(`${mobileConfig.aiApiUrl}/batch-analyze`);
  });

  it('uses Polish as the default language for a task review', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        task: 'Plan roadmap',
        langchain_analysis: { quadrant: 2, reasoning: 'Plan it.', confidence: 0.9, method: 'analysis' },
        rag_classification: { quadrant: 2, quadrant_name: 'Schedule', confidence: 0.8 },
        comparison: { methods_agree: true, confidence_difference: 0.1 },
      }),
    });

    await analyzeTaskAdvanced('Plan roadmap');
    expect(global.fetch.mock.calls[0][1].body).toBe(
      JSON.stringify({ task: 'Plan roadmap', language: 'pl' })
    );
  });

  it('loads only the public business capability flags used to gate tools', async () => {
    const capabilities = {
      classification: true,
      reasoned_local_analysis: true,
      knowledge_retrieval: false,
      retrieval_augmented_generation: false,
      local_similar_examples: false,
      ocr: true,
      batch_analysis: false,
    };
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => capabilities,
    });

    await expect(fetchAICapabilities()).resolves.toEqual(capabilities);
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/capabilities`,
      expect.any(Object)
    );
  });
});
