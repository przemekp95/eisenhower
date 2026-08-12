import { runtimeConfig } from '../config';
import { getAdminToken, getApiToken, setAdminToken } from '../authSession';
import {
  addTrainingExample,
  analyzeTask,
  analyzeTaskWithRag,
  batchAnalyzeTasks,
  clearTrainingData,
  classifyTask,
  createTask,
  deleteTask,
  extractTasksFromImage,
  getCapabilities,
  getExamplesByQuadrant,
  getTasks,
  getTrainingStats,
  learnFromAcceptedOCRTasks,
  learnFromFeedback,
  retrainModel,
  setProviderEnabled,
  updateTask,
  clearApiToken,
  setApiToken,
} from './api';

const taskResponse = {
  _id: '1',
  title: 'Task',
  description: '',
  urgent: false,
  important: false,
  revision: 4,
};

const trainingExample = {
  text: 'Task',
  quadrant: 0,
  source: 'user',
  timestamp: '2026-08-11T12:00:00Z',
};

const classificationResponse = {
  task: 'Task',
  urgent: true,
  important: true,
  quadrant: 0,
  quadrant_name: 'Do Now',
  timestamp: '2026-08-11T12:00:00Z',
  method: 'local-minilm',
  confidence: 0.9,
  local_scores: { 0: 0.9, 1: 0.05, 2: 0.03, 3: 0.02 },
  similar_examples_used: 0,
  top_similar_examples: [],
};

const analysisResponse = {
  task: 'Task',
  langchain_analysis: {
    quadrant: 0,
    reasoning: 'urgent',
    confidence: 0.9,
    method: 'local-analysis',
  },
  rag_classification: { quadrant: 0, quadrant_name: 'Do Now', confidence: 0.9 },
  comparison: { methods_agree: true, confidence_difference: 0 },
};

const groundedAiResponse = {
  mode: 'fallback',
  quadrant: 2,
  quadrant_name: 'Schedule',
  confidence: 0.7,
  explanation: 'fallback',
  citations: [],
  retrieval: { hit_count: 0, top_score: null, embedding_version: null },
  generation: null,
  information_delta: null,
};

describe('api service', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    setApiToken('runtime-only-test-token');
    setAdminToken('runtime-only-admin-token');
  });

  afterEach(() => {
    clearApiToken();
  });

  it('treats whitespace-only credentials as missing', () => {
    setApiToken('   ');

    expect(getApiToken()).toBeNull();
  });

  it('sends the runtime bearer token without putting it in URLs', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });

    await getTasks();

    expect(global.fetch).toHaveBeenCalledWith(
      `${runtimeConfig.apiUrl}/tasks`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer runtime-only-test-token' }),
      })
    );
    expect((global.fetch as jest.Mock).mock.calls[0][0]).not.toContain('runtime-only-test-token');
  });

  it('omits ambient browser credentials from both task and AI requests', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => classificationResponse,
      });

    await getTasks();
    await classifyTask('urgent');

    for (const [, request] of (global.fetch as jest.Mock).mock.calls) {
      expect(request).toEqual(
        expect.objectContaining({
          credentials: 'omit',
          headers: expect.objectContaining({ Authorization: 'Bearer runtime-only-test-token' }),
        })
      );
    }
  });

  it('clears the in-memory token after an unauthorized response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Authentication required' }),
    });

    await expect(getTasks()).rejects.toThrow('Authentication required');

    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    await getTasks();
    expect((global.fetch as jest.Mock).mock.calls[1][1]?.headers?.Authorization).toBeUndefined();
  });

  it('preserves admin credentials on authorization failures such as disabled management', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Administrator access required' }),
    });

    await expect(getTrainingStats()).rejects.toThrow('Administrator access required');

    expect(getApiToken()).toBe('runtime-only-test-token');
    expect(getAdminToken()).toBe('runtime-only-admin-token');
  });

  it('clears only the admin credential after an administrator authentication failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Invalid administrator code' }),
    });

    await expect(getTrainingStats()).rejects.toThrow('Invalid administrator code');

    expect(getApiToken()).toBe('runtime-only-test-token');
    expect(getAdminToken()).toBeNull();
  });

  it('uses runtime config for task CRUD', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => [taskResponse],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => taskResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ ...taskResponse, urgent: true }),
      });

    await getTasks();
    await createTask(
      { title: 'Task', description: '', urgent: false, important: false },
      'web-create-test'
    );
    await updateTask('1', { urgent: true }, 3);
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 204,
      headers: new Headers(),
      json: async () => undefined,
    });
    await deleteTask('1', 4);

    expect(global.fetch).toHaveBeenCalledWith(
      `${runtimeConfig.apiUrl}/tasks`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer runtime-only-test-token' }),
      })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `${runtimeConfig.apiUrl}/tasks`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Idempotency-Key': 'web-create-test' }),
      })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `${runtimeConfig.apiUrl}/tasks/1`,
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ 'If-Match': '"3"' }),
      })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `${runtimeConfig.apiUrl}/tasks/1`,
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ 'If-Match': '"4"' }),
      })
    );
  });

  it('uses runtime config for AI endpoints', async () => {
    const responses = [
      classificationResponse,
      analysisResponse,
      analysisResponse,
      {
        batch_results: [
          {
            task: 'Task',
            analyses: {
              rag: { quadrant: 0, quadrant_name: 'Do Now', confidence: 0.9 },
              langchain: {
                quadrant: 0,
                reasoning: 'urgent',
                confidence: 0.9,
                method: 'local-analysis',
              },
            },
          },
        ],
        summary: {
          methods: {
            rag: { quadrant_distribution: { 0: 1 } },
            langchain: { quadrant_distribution: { 0: 1 } },
          },
          total_tasks: 1,
        },
      },
      {
        filename: 'tasks.txt',
        image_info: { size_bytes: 4, shape: 'unknown' },
        ocr: { extracted_text: 'Task', raw_tasks_detected: 1, method: 'plain-text' },
        classified_tasks: [{ text: 'Task', quadrant: 0, quadrant_name: 'Do Now', confidence: 0.9 }],
        summary: {
          total_tasks: 1,
          quadrant_distribution: {
            counts: { 0: 1, 1: 0, 2: 0, 3: 0 },
            percentages: { 0: 100, 1: 0, 2: 0, 3: 0 },
            quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
          },
        },
      },
      { message: 'Training example added.', example: trainingExample },
      {
        message: 'Feedback captured.',
        predicted_quadrant: 1,
        correct_quadrant: 2,
        example: trainingExample,
      },
      { examples_added: 1, retrained: false },
      { message: 'Retrained.', preserve_experience: false, status: 'completed' },
      { message: 'Retrained.', preserve_experience: true, status: 'completed' },
      {
        total_examples: 1,
        quadrant_distribution: { 0: 1 },
        data_sources: { user: 1 },
        data_file: '/tmp/training.json',
        model_file: '/tmp/model.pt',
        last_updated: '2026-08-11T12:00:00Z',
        quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
      },
      { message: 'Training data cleared.', remaining_examples: 0 },
      { message: 'Training data cleared.', remaining_examples: 1 },
      { quadrant: 0, quadrant_name: 'Do Now', examples: [trainingExample] },
      { quadrant: 0, quadrant_name: 'Do Now', examples: [trainingExample] },
      {
        classification: true,
        langchain_analysis: false,
        ocr: true,
        batch_analysis: true,
        training_management: true,
        providers: { local_model: true, tesseract: true, ocr: true },
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
      },
      { provider: 'local_model', enabled: false, available: true, active: false },
      { provider: 'tesseract', enabled: true, available: true, active: true },
    ];
    (global.fetch as jest.Mock).mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => responses.shift(),
    }));

    await classifyTask('urgent');
    await analyzeTask('urgent');
    await analyzeTask('urgent', 'pl');
    await batchAnalyzeTasks(['one']);
    await extractTasksFromImage(new File(['task'], 'tasks.txt', { type: 'text/plain' }));
    await addTrainingExample('task', 1);
    await learnFromFeedback('task', 1, 2);
    await learnFromAcceptedOCRTasks([{ text: 'task', quadrant: 2 }], false);
    await retrainModel(false);
    await retrainModel();
    await getTrainingStats();
    await clearTrainingData(false);
    await clearTrainingData();
    await getExamplesByQuadrant(0);
    await getExamplesByQuadrant(0, 5);
    await getCapabilities();
    await setProviderEnabled('local_model', false);
    await setProviderEnabled('tesseract', true);

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(runtimeConfig.aiApiUrl);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(`${runtimeConfig.aiApiUrl}/classify`);
    expect((global.fetch as jest.Mock).mock.calls[0][1].body).toBe(
      JSON.stringify({ title: 'urgent', use_rag: true })
    );
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe(`${runtimeConfig.aiApiUrl}/analyze`);
    expect((global.fetch as jest.Mock).mock.calls[1][1].body).toBe(
      JSON.stringify({ task: 'urgent', language: 'en' })
    );
    expect((global.fetch as jest.Mock).mock.calls[2][1].body).toBe(
      JSON.stringify({ task: 'urgent', language: 'pl' })
    );
    expect((global.fetch as jest.Mock).mock.calls[7][0]).toContain('/learn-ocr-feedback');
    expect((global.fetch as jest.Mock).mock.calls[7][1].body).toBe(
      JSON.stringify({ tasks: [{ task: 'task', quadrant: 2 }], retrain: false })
    );
    expect((global.fetch as jest.Mock).mock.calls[8][1].body.toString()).toContain(
      'preserve_experience=false'
    );
    expect((global.fetch as jest.Mock).mock.calls[9][1].body.toString()).toContain(
      'preserve_experience=true'
    );
    expect((global.fetch as jest.Mock).mock.calls[11][0]).toContain(
      '/training-data?keep_defaults=false'
    );
    expect((global.fetch as jest.Mock).mock.calls[12][0]).toContain(
      '/training-data?keep_defaults=true'
    );
    expect((global.fetch as jest.Mock).mock.calls[13][0]).toContain('/examples/0?limit=10');
    expect((global.fetch as jest.Mock).mock.calls[16][0]).toContain('/providers/local_model');
    expect((global.fetch as jest.Mock).mock.calls[16][1].body).toBe(
      JSON.stringify({ enabled: false })
    );
    expect((global.fetch as jest.Mock).mock.calls[17][0]).toContain('/providers/tesseract');
    expect((global.fetch as jest.Mock).mock.calls[5][1].headers.Authorization).toBe(
      'Bearer runtime-only-admin-token'
    );
    expect((global.fetch as jest.Mock).mock.calls[6][1].headers.Authorization).toBe(
      'Bearer runtime-only-admin-token'
    );
    expect((global.fetch as jest.Mock).mock.calls[7][1].headers.Authorization).toBe(
      'Bearer runtime-only-admin-token'
    );
    expect((global.fetch as jest.Mock).mock.calls[8][1].headers.Authorization).toBe(
      'Bearer runtime-only-admin-token'
    );
  });

  it('uses the governed v2 analysis endpoint', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => groundedAiResponse,
    });

    await analyzeTaskWithRag('ground this task');

    expect(global.fetch).toHaveBeenCalledWith(
      `${runtimeConfig.aiApiUrl}/v2/ai/analyze`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ task: 'ground this task' }),
      })
    );
  });

  it('uses retrain=true by default for accepted OCR feedback', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ examples_added: 1, retrained: true }),
    });

    await learnFromAcceptedOCRTasks([{ text: 'task', quadrant: 0 }]);

    expect((global.fetch as jest.Mock).mock.calls[0][1].body).toBe(
      JSON.stringify({ tasks: [{ task: 'task', quadrant: 0 }], retrain: true })
    );
  });

  it('skips OCR feedback requests for empty accepted-task batches', async () => {
    await expect(learnFromAcceptedOCRTasks([])).resolves.toEqual({
      examples_added: 0,
      retrained: false,
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws JSON errors when requests fail', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: 'Validation failed' }),
    });

    await expect(
      createTask({ title: '', description: '', urgent: false, important: false })
    ).rejects.toThrow('Validation failed');
  });

  it('falls back to a generic JSON error when the payload has no message', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({}),
    });

    await expect(
      createTask({ title: '', description: '', urgent: false, important: false })
    ).rejects.toThrow('Task request failed');
  });

  it('throws a generic error for non-json failures', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => undefined,
    });

    await expect(classifyTask('urgent')).rejects.toThrow('AI request failed');
  });
});
