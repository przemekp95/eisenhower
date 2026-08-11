import { mobileConfig } from '../config';
import { setAccessToken, setAdminToken } from '../authSession';
import {
  addTrainingExample,
  analyzeTaskAdvanced,
  batchAnalyzeTasks,
  clearTrainingData,
  fetchAICapabilities,
  fetchTrainingStats,
  getExamplesByQuadrant,
  learnFromAcceptedOCRTasks,
  learnFromFeedback,
  retrainModel,
  setAIProviderEnabled,
  suggestTaskQuadrant,
} from './ai';

const classificationFixture = (task = 'urgent', quadrant = 1) => ({
  task,
  urgent: quadrant === 0 || quadrant === 1,
  important: quadrant === 0 || quadrant === 2,
  quadrant,
  quadrant_name: ['Do Now', 'Delegate', 'Schedule', 'Delete'][quadrant],
  timestamp: '2026-08-11T12:00:00Z',
  method: 'local-minilm',
  confidence: 0.9,
  local_scores: { 0: 0.03, 1: 0.9, 2: 0.04, 3: 0.03 },
  similar_examples_used: 0,
  top_similar_examples: [],
});

const analysisFixture = (task, quadrantName = 'Zaplanuj') => ({
  task,
  langchain_analysis: {
    reasoning: (
      'Lokalny model MiniLM przypisał zadanie do kwadrantu „Zaplanuj” z pewnością 86%. '
      + 'Model nie znalazł silnie podobnych przykładów w lokalnym zbiorze.'
    ),
    quadrant: 2,
    confidence: 0.86,
    method: 'local-analysis',
  },
  rag_classification: {
    quadrant: 2,
    quadrant_name: quadrantName,
    confidence: 0.86,
  },
  comparison: {
    methods_agree: true,
    confidence_difference: 0,
  },
  timestamp: '2026-08-11T12:00:00Z',
});

const trainingExampleFixture = (text, quadrant, source = 'user') => ({
  text,
  quadrant,
  source,
  timestamp: '2026-08-11T12:00:00Z',
});

describe('ai service', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    setAccessToken('test-api-token');
    setAdminToken('test-admin-token');
  });

  it('uses the central AI backend for suggestions', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => classificationFixture(),
    });

    await expect(suggestTaskQuadrant('urgent')).resolves.toEqual({
      urgent: true,
      important: false,
      source: 'central',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/classify`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'urgent', use_rag: true }),
        headers: expect.objectContaining({ Authorization: 'Bearer test-api-token' }),
      })
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
      json: async () => analysisFixture('Prepare roadmap'),
    });

    await expect(analyzeTaskAdvanced('Prepare roadmap', 'pl')).resolves.toMatchObject({
      langchain_analysis: {
        reasoning: expect.stringContaining('Lokalny model MiniLM'),
        quadrant: 2,
      },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/analyze`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ task: 'Prepare roadmap', language: 'pl' }),
        headers: expect.objectContaining({ Authorization: 'Bearer test-api-token' }),
      })
    );
  });

  it('uses default params for advanced analysis, retrain and examples browsing', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => analysisFixture('Przygotować plan'),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: 'Local MiniLM classifier retrained and promoted.',
          preserve_experience: true,
          status: 'completed',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ quadrant: 3, quadrant_name: 'Delete', examples: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: 'Training data cleared.', remaining_examples: 8 }),
      });

    await analyzeTaskAdvanced('Przygotować plan');
    await retrainModel();
    await getExamplesByQuadrant(3);
    await clearTrainingData();

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${mobileConfig.aiApiUrl}/analyze`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ task: 'Przygotować plan', language: 'pl' }),
        headers: expect.objectContaining({ Authorization: 'Bearer test-api-token' }),
      })
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
      `${mobileConfig.aiApiUrl}/examples/3?limit=10`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-admin-token' }),
      })
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
      json: async () => ({
        batch_results: [
          {
            task: 'a',
            analyses: {
              rag: { quadrant: 0, quadrant_name: 'Do Now', confidence: 0.9 },
              langchain: {
                quadrant: 0,
                reasoning: 'Urgent and important.',
                confidence: 0.9,
                method: 'local-analysis',
              },
            },
          },
          {
            task: 'b',
            analyses: {
              rag: { quadrant: 3, quadrant_name: 'Delete', confidence: 0.8 },
              langchain: {
                quadrant: 3,
                reasoning: 'Neither urgent nor important.',
                confidence: 0.8,
                method: 'local-analysis',
              },
            },
          },
        ],
        summary: {
          methods: {
            rag: { quadrant_distribution: { 0: 1, 1: 0, 2: 0, 3: 1 } },
            langchain: { quadrant_distribution: { 0: 1, 1: 0, 2: 0, 3: 1 } },
          },
          total_tasks: 2,
        },
      }),
    });

    await expect(batchAnalyzeTasks(['a', 'b'])).resolves.toMatchObject({
      summary: { total_tasks: 2 },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/batch-analyze`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-api-token',
        }),
        body: JSON.stringify({ tasks: ['a', 'b'] }),
      })
    );
  });

  it('loads AI capabilities from the central runtime', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        classification: true,
        langchain_analysis: false,
        ocr: true,
        batch_analysis: true,
        training_management: true,
        providers: { local_model: true, tesseract: true, ocr: true },
        provider_controls: {
          local_model: { enabled: true, available: true, active: true, reason: null },
          tesseract: { enabled: true, available: true, active: true, reason: null },
        },
        device: {
          type: 'cpu',
          name: 'cpu',
          vendor: 'cpu',
          runtime: 'cpu',
          runtime_version: null,
          torch_device: 'cpu',
          count: 1,
          cuda_version: null,
          accelerated: false,
        },
      }),
    });

    await expect(fetchAICapabilities()).resolves.toMatchObject({
      providers: { local_model: true, tesseract: true },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/capabilities`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-api-token' }),
      })
    );
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
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-admin-token',
        }),
        body: JSON.stringify({ enabled: false }),
      })
    );
  });

  it('loads training stats from the central runtime', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        total_examples: 9,
        quadrant_distribution: { 0: 3, 1: 2, 2: 2, 3: 2 },
        data_sources: { default: 8, user: 1 },
        data_file: '/app/data/training_data.json',
        model_file: '/app/data/local_model.pt',
        last_updated: '2026-08-11T12:00:00Z',
        quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
      }),
    });

    await expect(fetchTrainingStats()).resolves.toMatchObject({ total_examples: 9 });
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/training-stats`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-admin-token' }),
      })
    );
  });

  it('submits training examples and feedback', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: 'Training example added.',
          example: trainingExampleFixture('Plan roadmap', 2),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: 'Feedback captured.',
          predicted_quadrant: 1,
          correct_quadrant: 2,
          example: trainingExampleFixture('Plan roadmap', 2, 'feedback'),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: 'Feedback captured.',
          examples_added: 1,
          retrained: false,
          source: 'ocr-feedback',
          pending_review: true,
        }),
      });

    await expect(addTrainingExample('Plan roadmap', 2)).resolves.toMatchObject({
      message: 'Training example added.',
    });
    await expect(learnFromFeedback('Plan roadmap', 1, 2)).resolves.toMatchObject({
      message: 'Feedback captured.',
    });
    await expect(
      learnFromAcceptedOCRTasks([{ title: 'Plan roadmap', urgent: false, important: true }], false)
    ).resolves.toMatchObject({
      examples_added: 1,
      retrained: false,
    });

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${mobileConfig.aiApiUrl}/add-example`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Bearer test-admin-token',
        }),
        body: 'text=Plan+roadmap&quadrant=2',
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${mobileConfig.aiApiUrl}/learn-feedback`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Bearer test-admin-token',
        }),
        body: 'task=Plan+roadmap&predicted_quadrant=1&correct_quadrant=2',
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      `${mobileConfig.aiApiUrl}/learn-ocr-feedback`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-admin-token',
        }),
        body: JSON.stringify({
          tasks: [{ task: 'Plan roadmap', quadrant: 2 }],
          retrain: false,
        }),
      })
    );
  });

  it('maps accepted OCR tasks to all quadrants before sending feedback', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ examples_added: 4, retrained: true }),
    });

    await expect(
      learnFromAcceptedOCRTasks([
        { title: 'Do now', urgent: true, important: true },
        { title: 'Delegate', urgent: true, important: false },
        { title: 'Schedule', urgent: false, important: true },
        { title: 'Delete', urgent: false, important: false },
      ])
    ).resolves.toMatchObject({
      examples_added: 4,
      retrained: true,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/learn-ocr-feedback`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-admin-token',
        }),
        body: JSON.stringify({
          tasks: [
            { task: 'Do now', quadrant: 0 },
            { task: 'Delegate', quadrant: 1 },
            { task: 'Schedule', quadrant: 2 },
            { task: 'Delete', quadrant: 3 },
          ],
          retrain: true,
        }),
      })
    );
  });

  it('skips accepted OCR feedback requests when the task list is empty', async () => {
    await expect(learnFromAcceptedOCRTasks([], false)).resolves.toEqual({
      examples_added: 0,
      retrained: false,
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('handles retrain, clear data and examples browsing', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: 'Local MiniLM classifier retrained and promoted.',
          preserve_experience: false,
          status: 'completed',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: 'Training data cleared.', remaining_examples: 4 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quadrant: 0,
          quadrant_name: 'Do Now',
          examples: [trainingExampleFixture('urgent task', 0)],
        }),
      });

    await expect(retrainModel(false)).resolves.toMatchObject({ status: 'completed' });
    await expect(clearTrainingData(false)).resolves.toMatchObject({ remaining_examples: 4 });
    await expect(getExamplesByQuadrant(0, 5)).resolves.toMatchObject({
      examples: [expect.objectContaining({ text: 'urgent task', quadrant: 0 })],
    });

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${mobileConfig.aiApiUrl}/retrain`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Bearer test-admin-token',
        }),
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
      `${mobileConfig.aiApiUrl}/examples/0?limit=5`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-admin-token' }),
      })
    );
  });
});
