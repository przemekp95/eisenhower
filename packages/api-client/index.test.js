const test = require('node:test');
const assert = require('node:assert/strict');
const quadrantContract = require('../../contracts/quadrants.json');

const {
  AI_API_PATHS,
  QUADRANT_DEFINITIONS,
  createAiApi,
  createTaskApi,
  getAnalyzeTaskPath,
  isTaskAnalysisDto,
} = require('./index');

function taskFixture(overrides = {}) {
  return {
    _id: 'task-1',
    title: 'Updated',
    description: '',
    urgent: false,
    important: false,
    lifecycleState: 'active',
    revision: 4,
    ...overrides,
  };
}

function jsonResponse(payload, overrides = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    ...overrides,
  };
}

function classificationFixture(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function analysisFixture() {
  return {
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
}

function retrievalFixture() {
  return { hit_count: 0, top_score: null, embedding_version: null };
}

function trainingExampleFixture() {
  return { text: 'Task', quadrant: 0, source: 'user', timestamp: '2026-08-11T12:00:00Z' };
}

test('clears credentials only for authentication failures, not authorization failures', async () => {
  let userClears = 0;
  let adminClears = 0;
  const responses = [
    jsonResponse({ error: 'Invalid code' }, { ok: false, status: 401 }),
    jsonResponse({ error: 'Forbidden' }, { ok: false, status: 403 }),
    jsonResponse({ error: 'Invalid admin code' }, { ok: false, status: 401 }),
    jsonResponse({ error: 'Management disabled' }, { ok: false, status: 403 }),
  ];
  const api = createAiApi('https://ai.example.com', {
    fetch: async () => responses.shift(),
    accessToken: 'user-code',
    adminToken: 'admin-code',
    onUnauthorized: () => { userClears += 1; },
    onAdminUnauthorized: () => { adminClears += 1; },
  });

  await assert.rejects(() => api.classifyTask('one'));
  await assert.rejects(() => api.classifyTask('two'));
  await assert.rejects(() => api.fetchTrainingStats());
  await assert.rejects(() => api.fetchTrainingStats());

  assert.equal(userClears, 1);
  assert.equal(adminClears, 1);
});

test('sends optional task revisions through If-Match without breaking legacy calls', async () => {
  const calls = [];
  const api = createTaskApi('https://api.example.com', async (...args) => {
    calls.push(args);
    return {
      ok: true,
      status: args[1]?.method === 'DELETE' ? 204 : 200,
      json: async () => taskFixture(),
    };
  });

  await api.updateTask('task-1', { title: 'Updated' }, 3);
  await api.deleteTask('task-1', 4);
  await api.updateTask('legacy-task', { important: true });

  assert.equal(calls[0][1].headers['If-Match'], '"3"');
  assert.equal(calls[1][1].headers['If-Match'], '"4"');
  assert.equal(calls[2][1].headers['If-Match'], undefined);
});

test('sends an optional idempotency key for safe task creation retries', async () => {
  const calls = [];
  const api = createTaskApi('https://api.example.com', async (...args) => {
    calls.push(args);
    return jsonResponse(taskFixture(), { status: 201 });
  });

  await api.createTask({ title: 'Safe retry' }, 'web-create-123');
  await api.createTask({ title: 'Legacy create' });

  assert.equal(calls[0][1].headers['Idempotency-Key'], 'web-create-123');
  assert.equal(calls[1][1].headers['Idempotency-Key'], undefined);
});

test('uses bounded calendar status, sync and conflict endpoints with safety headers', async () => {
  const calls = [];
  const responses = [
    jsonResponse({ status: 'connected', connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' }, syncState: null, openConflicts: 1, pendingOutbox: 0 }),
    jsonResponse({ eventId: 'sync-1' }, { status: 202 }),
    jsonResponse([{ _id: 'conflict-1', taskId: 'task-1', providerSnapshot: { title: 'Google title', dueAt: '2026-08-20T12:00:00.000Z', timeZone: 'Europe/Warsaw' }, status: 'open', revision: 2 }]),
    jsonResponse({ _id: 'conflict-1', status: 'resolved_local', revision: 3 }),
  ];
  const api = createTaskApi('https://api.example.com', async (...args) => {
    calls.push(args);
    return responses.shift();
  });

  await api.getCalendarStatus();
  await api.requestCalendarSync('sync-key-1');
  await api.listCalendarConflicts();
  await api.resolveCalendarConflict('conflict/1', 'eisenhower', 2, 'resolve-key-1');

  assert.equal(calls[0][0], 'https://api.example.com/calendar/status');
  assert.equal(calls[1][0], 'https://api.example.com/calendar/sync-requests');
  assert.equal(calls[1][1].headers['Idempotency-Key'], 'sync-key-1');
  assert.equal(calls[2][0], 'https://api.example.com/calendar/conflicts');
  assert.equal(calls[3][0], 'https://api.example.com/calendar/conflicts/conflict%2F1/resolve');
  assert.equal(calls[3][1].headers['If-Match'], '"2"');
  assert.equal(calls[3][1].headers['Idempotency-Key'], 'resolve-key-1');
  assert.deepEqual(JSON.parse(calls[3][1].body), { strategy: 'eisenhower' });
});

test('filters task lists by lifecycle and sends conflict-safe lifecycle transitions', async () => {
  const calls = [];
  const api = createTaskApi('https://api.example.com', async (...args) => {
    calls.push(args);
    return jsonResponse(
      args[0].includes('/lifecycle')
        ? taskFixture({ lifecycleState: 'completed', revision: 5 })
        : [taskFixture({ lifecycleState: 'trashed' })],
      { headers: { get: () => null } }
    );
  });

  const trashedTasks = await api.listTasks('trashed');
  const completedTask = await api.transitionTaskLifecycle('task/1', 'complete', 4);

  assert.equal(trashedTasks[0].lifecycleState, 'trashed');
  assert.equal(completedTask.lifecycleState, 'completed');
  assert.equal(calls[0][0], 'https://api.example.com/tasks?lifecycle=trashed');
  assert.equal(calls[1][0], 'https://api.example.com/tasks/task%2F1/lifecycle');
  assert.equal(calls[1][1].method, 'PUT');
  assert.equal(calls[1][1].headers['If-Match'], '"4"');
  assert.deepEqual(JSON.parse(calls[1][1].body), { action: 'complete' });
});

test('sets and clears task schedules with an optional revision', async () => {
  const calls = [];
  const api = createTaskApi('https://api.example.com', async (...args) => {
    calls.push(args);
    return jsonResponse(
      taskFixture({
        schedule:
          args[1].body === '{"schedule":null}'
            ? undefined
            : {
                dueAt: '2026-08-15T12:00:00.000Z',
                timeZone: 'Europe/Warsaw',
                remindAt: '2026-08-15T10:00:00.000Z',
              },
      })
    );
  });

  const schedule = {
    dueAt: '2026-08-15T12:00:00.000Z',
    timeZone: 'Europe/Warsaw',
    remindAt: '2026-08-15T10:00:00.000Z',
  };
  await api.updateTaskSchedule('task/1', schedule, 4);
  await api.updateTaskSchedule('task/1', null);

  assert.equal(calls[0][0], 'https://api.example.com/tasks/task%2F1/schedule');
  assert.equal(calls[0][1].method, 'PUT');
  assert.equal(calls[0][1].headers['If-Match'], '"4"');
  assert.deepEqual(JSON.parse(calls[0][1].body), { schedule });
  assert.deepEqual(JSON.parse(calls[1][1].body), { schedule: null });
  assert.equal(calls[1][1].headers['If-Match'], undefined);
});

test('lists delegated work and sends revision-safe owner and assignee delegation commands', async () => {
  const calls = [];
  const delegation = {
    assigneeUserId: 'user-b',
    displayLabel: 'Pat',
    handoffNote: 'Use the release runbook.',
    status: 'offered',
    offeredAt: '2026-08-12T12:00:00.000Z',
    statusUpdatedAt: '2026-08-12T12:00:00.000Z',
  };
  const api = createTaskApi('https://api.example.com', async (...args) => {
    calls.push(args);
    return jsonResponse(
      args[0].endsWith('/delegated') ? [taskFixture({ delegation })] : taskFixture({ delegation })
    );
  });

  const delegated = await api.listDelegatedTasks();
  await api.updateTaskDelegation(
    'task/1',
    { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: 'Use the release runbook.' },
    4
  );
  await api.transitionTaskDelegation('task/1', 'accepted', 5);

  assert.equal(delegated[0].delegation.status, 'offered');
  assert.equal(calls[0][0], 'https://api.example.com/tasks/delegated');
  assert.equal(calls[1][0], 'https://api.example.com/tasks/task%2F1/delegation');
  assert.equal(calls[1][1].headers['If-Match'], '"4"');
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    delegation: {
      assigneeUserId: 'user-b',
      displayLabel: 'Pat',
      handoffNote: 'Use the release runbook.',
    },
  });
  assert.equal(calls[2][0], 'https://api.example.com/tasks/task%2F1/delegation/status');
  assert.equal(calls[2][1].headers['If-Match'], '"5"');
  assert.deepEqual(JSON.parse(calls[2][1].body), { status: 'accepted' });
});

test('rejects malformed delegation state at the public API boundary', async () => {
  const api = createTaskApi('https://api.example.com', async () =>
    jsonResponse([
      taskFixture({
        delegation: {
          assigneeUserId: 'user-b',
          displayLabel: 'Pat',
          handoffNote: '',
          status: 'queued',
          offeredAt: '2026-08-12T12:00:00.000Z',
          statusUpdatedAt: '2026-08-12T12:00:00.000Z',
        },
      }),
    ])
  );

  await assert.rejects(
    api.listDelegatedTasks(),
    (error) => error.code === 'invalid_response' && error.status === 200
  );
});

test('rejects malformed task schedules at the public API boundary', async () => {
  const api = createTaskApi('https://api.example.com', async () =>
    jsonResponse(
      taskFixture({
        schedule: {
          dueAt: '2026-08-15T12:00:00.000Z',
          timeZone: 'Europe/Warsaw',
          recurrence: 'daily',
        },
      })
    )
  );

  await assert.rejects(
    api.createTask({ title: 'Task', description: '', urgent: false, important: false }),
    (error) => error.code === 'invalid_response' && error.status === 200
  );
});

test('publishes one canonical quadrant contract', () => {
  assert.deepEqual(QUADRANT_DEFINITIONS, quadrantContract);
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

  assert.equal(calls[0][0], 'http://ai.internal/analyze');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    task: 'triage incident',
    language: 'en',
  });
  assert.equal(AI_API_PATHS.analyzeTask, '/analyze');
  assert.equal(getAnalyzeTaskPath('triage incident'), '/analyze');
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

test('uses the governed claim-cited knowledge answer contract', async () => {
  const calls = [];
  const api = createAiApi('https://api.example.com', {
    accessToken: () => 'access-token',
    fetch: async (...args) => {
      calls.push(args);
      return jsonResponse({
        status: 'answered',
        answer: 'MongoDB is canonical.',
        claims: [{ statement: 'MongoDB is canonical.', citation_ids: ['chunk-1'] }],
        citations: [{
          chunk_id: 'chunk-1', document_id: 'doc-1', source_uri: 'knowledge://architecture',
          title: 'Architecture', excerpt: 'MongoDB is canonical.', score: 0.9,
          content_version: 'v1',
        }],
        retrieval: { hit_count: 1, top_score: 0.9, embedding_version: 'bge-m3-v1' },
        generation: null,
        no_answer_reason: null,
      });
    },
  });

  const result = await api.answerKnowledge('Co jest kanoniczne?', 'pl', 'project-1', 3);

  assert.equal(result.status, 'answered');
  assert.equal(calls[0][0], 'https://api.example.com/v2/knowledge/answer');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    query: 'Co jest kanoniczne?', language: 'pl', project_id: 'project-1', limit: 3,
  });
});

test('rejects malformed task payloads at the public API boundary', async () => {
  const api = createTaskApi('https://api.example.com', async () =>
    jsonResponse([taskFixture({ important: 'yes' })])
  );

  await assert.rejects(
    api.listTasks(),
    (error) =>
      error.message === 'Task API returned an invalid response' &&
      error.code === 'invalid_response' &&
      error.status === 200
  );
});

test('listTasks follows encoded pagination cursors with bearer auth and aggregates validated pages', async () => {
  const calls = [];
  const responses = [
    jsonResponse([taskFixture({ _id: 'task-1' })], {
      headers: {
        get: (name) => (name.toLowerCase() === 'x-next-cursor' ? 'next cursor/+?' : null),
      },
    }),
    jsonResponse([taskFixture({ _id: 'task-2' })], {
      headers: { get: () => null },
    }),
  ];
  const api = createTaskApi('https://api.example.com', {
    accessToken: 'access-token',
    fetch: async (...args) => {
      calls.push(args);
      return responses.shift();
    },
  });

  const tasks = await api.listTasks();

  assert.deepEqual(
    tasks.map((task) => task._id),
    ['task-1', 'task-2']
  );
  assert.equal(calls[0][0], 'https://api.example.com/tasks');
  assert.equal(calls[1][0], 'https://api.example.com/tasks?cursor=next%20cursor%2F%2B%3F');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer access-token');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer access-token');
});

test('listTasks rejects malformed later pages and repeated cursors', async () => {
  const page = (payload, cursor) =>
    jsonResponse(payload, {
      headers: { get: () => cursor },
    });

  const malformedApi = createTaskApi('https://api.example.com', async () =>
    malformedApi.calls++ === 0
      ? page([taskFixture()], 'page-2')
      : page([taskFixture({ urgent: 'yes' })], null)
  );
  malformedApi.calls = 0;
  await assert.rejects(malformedApi.listTasks(), (error) => error.code === 'invalid_response');

  const responses = [page([taskFixture()], 'same'), page([taskFixture()], 'same')];
  const repeatedApi = createTaskApi('https://api.example.com', async () => responses.shift());
  await assert.rejects(
    repeatedApi.listTasks(),
    (error) => error.code === 'invalid_response' && /cursor/i.test(error.message)
  );
});

test('listTasks enforces a bounded page limit', async () => {
  let calls = 0;
  const api = createTaskApi('https://api.example.com', async () => {
    calls += 1;
    return jsonResponse([taskFixture({ _id: `task-${calls}` })], {
      headers: { get: () => `page-${calls + 1}` },
    });
  });

  await assert.rejects(
    api.listTasks(),
    (error) => error.code === 'invalid_response' && /page limit/i.test(error.message)
  );
  assert.ok(calls > 1 && calls < 1000);
});

test('rejects drifted quadrant semantics at the public AI boundary', async () => {
  const api = createAiApi('https://api.example.com', async () =>
    jsonResponse({
      task: 'delegate inbox',
      urgent: false,
      important: true,
      quadrant: 1,
      quadrant_name: 'Schedule',
      timestamp: '2026-08-11T12:00:00Z',
      method: 'local-minilm',
      confidence: 0.9,
      local_scores: { 0: 0.05, 1: 0.9, 2: 0.03, 3: 0.02 },
      similar_examples_used: 0,
      top_similar_examples: [],
    })
  );

  await assert.rejects(
    api.classifyTask('delegate inbox'),
    (error) => error.code === 'invalid_response' && error.status === 200
  );
});

test('rejects payloads that silently drop required AI contract fields', async () => {
  const responses = [
    jsonResponse(classificationFixture({ local_scores: undefined })),
    jsonResponse({
      classification: true,
      langchain_analysis: false,
      ocr: true,
      batch_analysis: true,
      training_management: true,
      providers: { local_model: true, tesseract: true, ocr: true },
    }),
  ];
  const api = createAiApi('https://api.example.com', async () => responses.shift());

  await assert.rejects(api.classifyTask('Task'), (error) => error.code === 'invalid_response');
  await assert.rejects(api.fetchCapabilities(), (error) => error.code === 'invalid_response');
});

test('sanitizes malformed error payloads instead of trusting drifted fields', async () => {
  const api = createAiApi('https://api.example.com', async () =>
    jsonResponse(
      { error: { private: 'upstream detail' }, code: ['drifted_code'] },
      { ok: false, status: 502 }
    )
  );

  await assert.rejects(
    api.fetchCapabilities(),
    (error) =>
      error.message === 'AI request failed' &&
      error.code === 'ai_request_failed' &&
      error.status === 502 &&
      !error.message.includes('upstream detail')
  );
});

test('preserves validated error fields at the public API boundary', async () => {
  const api = createAiApi('https://api.example.com', async () =>
    jsonResponse(
      { error: 'Local model provider is disabled.', code: 'provider_disabled' },
      { ok: false, status: 503 }
    )
  );

  await assert.rejects(
    api.classifyTask('Task'),
    (error) =>
      error.message === 'Local model provider is disabled.' &&
      error.code === 'provider_disabled' &&
      error.status === 503
  );
});

test('every body-bearing public method rejects a non-contract success payload', async () => {
  const request = async () => jsonResponse('drifted');
  const taskApi = createTaskApi('https://api.example.com', request);
  const aiApi = createAiApi('https://api.example.com', request);
  const calls = [
    () => taskApi.listTasks(),
    () => taskApi.createTask({ title: 'Task', description: '', urgent: false, important: false }),
    () => taskApi.updateTask('task-1', { title: 'Task' }),
    () => taskApi.deleteTask('task-1'),
    () => taskApi.getHealth(),
    () => taskApi.getReadiness(),
    () => aiApi.classifyTask('Task'),
    () => aiApi.analyzeTask('Task'),
    () => aiApi.analyzeTaskWithRag('Task'),
    () => aiApi.searchKnowledge('Task'),
    () => aiApi.extractTasksFromImage(new Blob(['task'], { type: 'text/plain' })),
    () => aiApi.batchAnalyzeTasks(['Task']),
    () => aiApi.fetchCapabilities(),
    () => aiApi.fetchTrainingStats(),
    () => aiApi.setProviderEnabled('local_model', true),
    () => aiApi.addTrainingExample('Task', 0),
    () => aiApi.learnFromFeedback('Task', 1, 0),
    () => aiApi.learnFromAcceptedOcrTasks([{ text: 'Task', quadrant: 0 }]),
    () => aiApi.retrainModel(),
    () => aiApi.clearTrainingData(),
    () => aiApi.getExamplesByQuadrant(0),
  ];

  for (const call of calls) {
    await assert.rejects(call(), (error) => error.code === 'invalid_response');
  }
});

test('accepts representative payloads for every declared public response contract', async () => {
  const responses = [
    jsonResponse([taskFixture()]),
    jsonResponse(taskFixture()),
    jsonResponse(taskFixture()),
    jsonResponse(null, { status: 204 }),
    jsonResponse({ status: 'ok' }),
    jsonResponse({ status: 'ready' }),
    jsonResponse(classificationFixture()),
    jsonResponse(analysisFixture()),
    jsonResponse({
      mode: 'fallback',
      quadrant: 2,
      quadrant_name: 'Schedule',
      confidence: 0.7,
      explanation: 'fallback',
      citations: [],
      retrieval: retrievalFixture(),
      generation: null,
      information_delta: null,
    }),
    jsonResponse({
      query: 'Task',
      answer: null,
      citations: [],
      retrieval: retrievalFixture(),
      no_answer_reason: null,
    }),
    jsonResponse({
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
    }),
    jsonResponse({
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
    }),
    jsonResponse({
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
    }),
    jsonResponse({
      total_examples: 1,
      quadrant_distribution: { 0: 1 },
      data_sources: { user: 1 },
      data_file: '/tmp/training.json',
      model_file: '/tmp/model.pt',
      last_updated: '2026-08-11T12:00:00Z',
      quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
    }),
    jsonResponse({
      provider: 'local_model',
      enabled: true,
      available: true,
      active: true,
      reason: null,
    }),
    jsonResponse({ message: 'Training example added.', example: trainingExampleFixture() }),
    jsonResponse({
      message: 'Feedback captured.',
      predicted_quadrant: 1,
      correct_quadrant: 0,
      example: trainingExampleFixture(),
    }),
    jsonResponse({
      message: 'Feedback captured.',
      examples_added: 1,
      retrained: false,
      source: 'ocr-feedback',
      pending_review: true,
    }),
    jsonResponse({
      message: 'Local MiniLM classifier retrained and promoted.',
      preserve_experience: true,
      preserve_experience_deprecated: true,
      status: 'completed',
    }),
    jsonResponse({ message: 'Training data cleared.', remaining_examples: 0 }),
    jsonResponse({ quadrant: 0, quadrant_name: 'Do Now', examples: [trainingExampleFixture()] }),
  ];
  const request = async () => responses.shift();
  const taskApi = createTaskApi('https://api.example.com', request);
  const aiApi = createAiApi('https://api.example.com', request);

  await taskApi.listTasks();
  await taskApi.createTask({ title: 'Task', description: '', urgent: false, important: false });
  await taskApi.updateTask('task-1', { title: 'Task' });
  await taskApi.deleteTask('task-1');
  await taskApi.getHealth();
  await taskApi.getReadiness();
  await aiApi.classifyTask('Task');
  await aiApi.analyzeTask('Task');
  await aiApi.analyzeTaskWithRag('Task');
  await aiApi.searchKnowledge('Task');
  await aiApi.extractTasksFromImage(new Blob(['Task'], { type: 'text/plain' }));
  await aiApi.batchAnalyzeTasks(['Task']);
  await aiApi.fetchCapabilities();
  await aiApi.fetchTrainingStats();
  await aiApi.setProviderEnabled('local_model', true);
  await aiApi.addTrainingExample('Task', 0);
  await aiApi.learnFromFeedback('Task', 1, 0);
  await aiApi.learnFromAcceptedOcrTasks([{ text: 'Task', quadrant: 0 }]);
  await aiApi.retrainModel();
  await aiApi.clearTrainingData();
  await aiApi.getExamplesByQuadrant(0);

  assert.equal(responses.length, 0);
});
