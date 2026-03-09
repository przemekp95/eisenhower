import { mobileConfig } from '../config';
import {
  addTrainingExample,
  analyzeTaskAdvanced,
  batchAnalyzeTasks,
  clearTrainingData,
  fetchAICapabilities,
  fetchTrainingStats,
  getExamplesByQuadrant,
  learnFromFeedback,
  retrainModel,
  setAIProviderEnabled,
  suggestTaskQuadrant,
} from './ai';

describe('ai service', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('uses the central AI backend for suggestions', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ urgent: true, important: false }),
    });

    await expect(suggestTaskQuadrant('urgent')).resolves.toEqual({
      urgent: true,
      important: false,
      source: 'central',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/classify?title=urgent&use_rag=true`
    );
  });

  it('throws a provider error when central AI is disabled', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Local model provider is disabled.', code: 'provider_disabled' }),
    });

    await expect(suggestTaskQuadrant('watch series')).rejects.toMatchObject({
      code: 'provider_disabled',
      message: 'Local model provider is disabled.',
      status: 503,
    });
  });

  it('falls back to generic AI errors when the payload cannot be parsed', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('bad json');
      },
    });

    await expect(fetchAICapabilities()).rejects.toMatchObject({
      code: 'ai_request_failed',
      message: 'AI request failed',
      status: 500,
    });
  });

  it('runs advanced analysis through the central runtime', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ langchain_analysis: { reasoning: 'Because', quadrant: 2 } }),
    });

    await expect(analyzeTaskAdvanced('Prepare roadmap', 'pl')).resolves.toMatchObject({
      langchain_analysis: { reasoning: 'Because', quadrant: 2 },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/analyze-langchain?task=Prepare%20roadmap&language=pl`,
      { method: 'POST' }
    );
  });

  it('uses default params for advanced analysis, retrain and examples browsing', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'completed' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ examples: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ remaining_examples: 8 }) });

    await analyzeTaskAdvanced('Przygotować plan');
    await retrainModel();
    await getExamplesByQuadrant(3);
    await clearTrainingData();

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${mobileConfig.aiApiUrl}/analyze-langchain?task=Przygotowa%C4%87%20plan&language=pl`,
      { method: 'POST' }
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${mobileConfig.aiApiUrl}/retrain`,
      expect.objectContaining({
        body: 'preserve_experience=true',
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      `${mobileConfig.aiApiUrl}/examples/3?limit=10`
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      4,
      `${mobileConfig.aiApiUrl}/training-data?keep_defaults=true`,
      expect.objectContaining({
        method: 'DELETE',
      })
    );
  });

  it('runs bulk analysis through the central runtime', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ summary: { total_tasks: 2 } }),
    });

    await expect(batchAnalyzeTasks(['a', 'b'])).resolves.toMatchObject({
      summary: { total_tasks: 2 },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/batch-analyze`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: ['a', 'b'] }),
      })
    );
  });

  it('loads AI capabilities from the central runtime', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        providers: { local_model: true, tesseract: true },
        provider_controls: {
          local_model: { enabled: true, available: true, active: true, reason: null },
          tesseract: { enabled: true, available: true, active: true, reason: null },
        },
      }),
    });

    await expect(fetchAICapabilities()).resolves.toMatchObject({
      providers: { local_model: true, tesseract: true },
    });
    expect(global.fetch).toHaveBeenCalledWith(`${mobileConfig.aiApiUrl}/capabilities`);
  });

  it('updates provider state through the central runtime', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'local_model', enabled: false, available: true, active: false }),
    });

    await expect(setAIProviderEnabled('local_model', false)).resolves.toMatchObject({
      provider: 'local_model',
      enabled: false,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/providers/local_model`,
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
    );
  });

  it('loads training stats from the central runtime', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ total_examples: 9 }),
    });

    await expect(fetchTrainingStats()).resolves.toEqual({ total_examples: 9 });
    expect(global.fetch).toHaveBeenCalledWith(`${mobileConfig.aiApiUrl}/training-stats`);
  });

  it('submits training examples and feedback', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: 'Training example added.' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: 'Feedback captured.' }) });

    await expect(addTrainingExample('Plan roadmap', 2)).resolves.toMatchObject({
      message: 'Training example added.',
    });
    await expect(learnFromFeedback('Plan roadmap', 1, 2)).resolves.toMatchObject({
      message: 'Feedback captured.',
    });

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${mobileConfig.aiApiUrl}/add-example`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'text=Plan+roadmap&quadrant=2',
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${mobileConfig.aiApiUrl}/learn-feedback`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'task=Plan+roadmap&predicted_quadrant=1&correct_quadrant=2',
      })
    );
  });

  it('handles retrain, clear data and examples browsing', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'completed' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ remaining_examples: 4 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ examples: [{ text: 'urgent task', quadrant: 0 }] }) });

    await expect(retrainModel(false)).resolves.toMatchObject({ status: 'completed' });
    await expect(clearTrainingData(false)).resolves.toMatchObject({ remaining_examples: 4 });
    await expect(getExamplesByQuadrant(0, 5)).resolves.toMatchObject({
      examples: [{ text: 'urgent task', quadrant: 0 }],
    });

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${mobileConfig.aiApiUrl}/retrain`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'preserve_experience=false',
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${mobileConfig.aiApiUrl}/training-data?keep_defaults=false`,
      expect.objectContaining({
        method: 'DELETE',
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      `${mobileConfig.aiApiUrl}/examples/0?limit=5`
    );
  });
});
