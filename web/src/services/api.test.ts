import { runtimeConfig } from '../config';
import { getApiToken } from '../authSession';
import {
  analyzeTask,
  analyzeTaskWithRag,
  answerKnowledge,
  batchAnalyzeTasks,
  classifyTask,
  createTask,
  deleteTask,
  extractTasksFromImage,
  getCapabilities,
  getCalendarConflicts,
  getCalendarStatus,
  getDelegatedTasks,
  getTasks,
  prepareMemory,
  confirmMemory,
  exportMemory,
  requestCalendarSync,
  disconnectCalendar,
  resolveCalendarConflict,
  transitionTaskLifecycle,
  transitionTaskDelegation,
  updateTaskDelegation,
  updateTaskSchedule,
  updateTask,
  clearApiToken,
  setApiToken,
  startCalendarConnection,
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
          canConnect: true,
          failedSyncCount: 0,
          syncProblem: false,
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
      `${runtimeConfig.apiUrl}/tasks/delegated?lifecycle=active`,
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

  it('starts and disconnects a calendar connection through business-facing wrappers', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ authorizationUrl: 'https://accounts.google.com/o/oauth2/auth' }),
      })
      .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers() });

    await startCalendarConnection('/matrix?tab=calendar');
    await disconnectCalendar();

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${runtimeConfig.apiUrl}/calendar/oauth/start`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ returnPath: '/matrix?tab=calendar' }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${runtimeConfig.apiUrl}/calendar/oauth/disconnect`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('reads the public business capabilities', async () => {
    const capabilities = {
      classification: true,
      reasoned_local_analysis: true,
      knowledge_retrieval: true,
      retrieval_augmented_generation: true,
      local_similar_examples: true,
      ocr: true,
      batch_analysis: true,
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => capabilities,
    });

    await expect(getCapabilities()).resolves.toEqual(capabilities);
    expect(global.fetch).toHaveBeenCalledWith(
      `${runtimeConfig.aiApiUrl}/capabilities`,
      expect.objectContaining({ credentials: 'omit' })
    );
  });

  it('uses the governed prepare, confirm and export memory endpoints', async () => {
    const intent = {
      action: 'create' as const,
      memory_id: 'preference-1',
      memory_type: 'communication_preference',
      conflict_key: 'response-style',
      content: 'Prefer concise Polish responses',
      source_event_id: 'web-memory-1',
      provenance: 'explicit web memory control',
      confidence: 1,
      salience: 0.8,
      retention_class: 'user_controlled',
      expires_at: '2026-09-17T00:00:00Z',
    };
    const receipt = {
      confirmation_id: `h1:runtime:${'a'.repeat(64)}`,
      actor_user_id: 'owner-user',
      action: 'create' as const,
      intent_checksum: 'b'.repeat(64),
      policy_version: 'eisenhower-memory-consent-v1',
      confirmed_at: '2026-08-17T00:00:00Z',
      expires_at: '2026-08-17T00:05:00Z',
    };
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ action: 'create', memory_id: 'preference-1', receipt }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          memory_id: 'preference-1',
          status: 'active',
          projection_state: 'synchronized',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ items: [] }),
      });

    const prepared = await prepareMemory(intent);
    await confirmMemory(intent, prepared.receipt, 'memory-create-1');
    await exportMemory();

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${runtimeConfig.aiApiUrl}/v2/memory/prepare`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify(intent) })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${runtimeConfig.aiApiUrl}/v2/memory/confirm`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Idempotency-Key': 'memory-create-1' }),
        body: JSON.stringify({ intent, receipt }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      `${runtimeConfig.aiApiUrl}/v2/memory/export`,
      expect.objectContaining({ credentials: 'omit' })
    );
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
