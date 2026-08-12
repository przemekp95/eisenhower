import { runtimeConfig } from '../config';
import { getAdminToken, getApiToken, setAdminToken } from '../authSession';
import {
  addTrainingExample,
  analyzeTask,
  analyzeTaskWithRag,
  answerKnowledge,
  answerKnowledge,
  batchAnalyzeTasks,
  clearTrainingData,
  classifyTask,
  createTask,
  deleteTask,
  extractTasksFromImage,
  getCapabilities,
  getCalendarConflicts,
  getCalendarStatus,
  getDelegatedTasks,
  getExamplesByQuadrant,
  getTasks,
  getTrainingStats,
  learnFromAcceptedOCRTasks,
  learnFromFeedback,
  retrainModel,
  requestCalendarSync,
  resolveCalendarConflict,
  setProviderEnabled,
  transitionTaskLifecycle,
  transitionTaskDelegation,
  updateTaskDelegation,
  updateTaskSchedule,
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
  lifecycleState: 'active' as const,
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

  it('uses the authenticated calendar endpoints for status, sync, conflicts and resolution', async () => {
    const calendarConflict = {
      _id: 'conflict-1',
      taskId: 'task-1',
      status: 'open' as const,
      revision: 2,
      providerSnapshot: {
        title: 'Google title',
        dueAt: '2026-08-20T12:00:00.000Z',
        timeZone: 'Europe/Warsaw',
      },
    };
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          status: 'connected',
          connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
          openConflicts: 1,
          pendingOutbox: 0,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ eventId: 'sync-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => [calendarConflict],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ ...calendarConflict, status: 'resolved_provider', revision: 3 }),
      });

    await getCalendarStatus();
    await requestCalendarSync('sync-key');
    await getCalendarConflicts();
    await resolveCalendarConflict('conflict/1', 'google', 2, 'resolve-key');

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${runtimeConfig.apiUrl}/calendar/status`,
      expect.objectContaining({ credentials: 'omit' })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${runtimeConfig.apiUrl}/calendar/sync-requests`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Idempotency-Key': 'sync-key' }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      `${runtimeConfig.apiUrl}/calendar/conflicts`,
      expect.objectContaining({ credentials: 'omit' })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      4,
      `${runtimeConfig.apiUrl}/calendar/conflicts/conflict%2F1/resolve`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Idempotency-Key': 'resolve-key',
          'If-Match': '"2"',
        }),
        body: JSON.stringify({ strategy: 'google' }),
      })
    );
  });

  it('filters lifecycle views and sends revision-safe lifecycle actions', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [{ ...taskResponse, lifecycleState: 'trashed' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ ...taskResponse, lifecycleState: 'active', revision: 5 }),
      });

    await getTasks('trashed');
    await transitionTaskLifecycle('task/1', 'restore', 4);

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${runtimeConfig.apiUrl}/tasks?lifecycle=trashed`,
      expect.any(Object)
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${runtimeConfig.apiUrl}/tasks/task%2F1/lifecycle`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ action: 'restore' }),
        headers: expect.objectContaining({ 'If-Match': '"4"' }),
      })
    );
  });

  it('sets and clears task schedules through the shared client', async () => {
    const schedule = {
      dueAt: '2026-08-15T12:00:00.000Z',
      timeZone: 'Europe/Warsaw',
      remindAt: '2026-08-15T10:00:00.000Z',
    };
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ ...taskResponse, schedule, revision: 5 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ ...taskResponse, revision: 6 }),
      });

    await updateTaskSchedule('task/1', schedule, 4);
    await updateTaskSchedule('task/1', null, 5);

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${runtimeConfig.apiUrl}/tasks/task%2F1/schedule`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ schedule }),
        headers: expect.objectContaining({ 'If-Match': '"4"' }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${runtimeConfig.apiUrl}/tasks/task%2F1/schedule`,
      expect.objectContaining({ body: JSON.stringify({ schedule: null }) })
    );
  });

  it('lists delegated work and sends delegation commands through the shared client', async () => {
    const delegation = {
      assigneeUserId: 'user-b',
      displayLabel: 'Pat',
      handoffNote: 'Use the runbook.',
      status: 'offered' as const,
      offeredAt: '2026-08-12T12:00:00.000Z',
      statusUpdatedAt: '2026-08-12T12:00:00.000Z',
    };
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [{ ...taskResponse, delegation }],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ ...taskResponse, delegation, revision: 5 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          ...taskResponse,
          delegation: { ...delegation, status: 'accepted' },
          revision: 6,
        }),
      });

    await getDelegatedTasks();
    await updateTaskDelegation(
      'task/1',
      { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: 'Use the runbook.' },
      4
    );
    await transitionTaskDelegation('task/1', 'accepted', 5);

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${runtimeConfig.apiUrl}/tasks/delegated`,
      expect.any(Object)
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${runtimeConfig.apiUrl}/tasks/task%2F1/delegation`,
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ 'If-Match': '"4"' }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      `${runtimeConfig.apiUrl}/tasks/task%2F1/delegation/status`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ status: 'accepted' }),
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

  it('uses the governed knowledge-answer endpoint with the UI language', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        status: 'insufficient_evidence',
        answer: null,
        claims: [],
        citations: [],
        retrieval: { hit_count: 0, top_score: null, embedding_version: null },
        generation: null,
        no_answer_reason: 'insufficient_context',
      }),
    });

    await answerKnowledge('Nieznane pytanie', 'pl');

    expect(global.fetch).toHaveBeenCalledWith(
      `${runtimeConfig.aiApiUrl}/v2/knowledge/answer`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          query: 'Nieznane pytanie',
          language: 'pl',
          project_id: null,
          limit: 5,
        }),
      })
    );
  });

  it('uses the separate governed knowledge-answer endpoint', async () => {
    const response = {
      status: 'insufficient_evidence',
      answer: null,
      claims: [],
      citations: [],
      retrieval: { hit_count: 0, top_score: null, embedding_version: null },
      no_answer_reason: 'no_retrieval_hits',
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => response,
    });

    await expect(answerKnowledge('What is approved?', 'pl')).resolves.toEqual(response);
    expect(global.fetch).toHaveBeenCalledWith(
      `${runtimeConfig.aiApiUrl}/v2/knowledge/answer`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          query: 'What is approved?',
          language: 'pl',
          project_id: null,
          limit: 5,
        }),
      })
    );

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => response,
    });
    await answerKnowledge('What is approved?');
    expect((global.fetch as jest.Mock).mock.calls[1][1].body).toBe(
      JSON.stringify({
        query: 'What is approved?',
        language: 'en',
        project_id: null,
        limit: 5,
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
