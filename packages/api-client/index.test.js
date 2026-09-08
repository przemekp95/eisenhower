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
  stripImageMetadata,
  stripJpegMetadata,
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

test('JPEG metadata stripping removes private segments and preserves encoded image bytes', () => {
  const jpeg = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x11, 0x22,
    0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0xff, 0xe1, 0x00, 0x05, 0x58, 0x4d, 0x50,
    0xff, 0xed, 0x00, 0x04, 0x33, 0x44,
    0xff, 0xfe, 0x00, 0x05, 0x61, 0x62, 0x63,
    0xff, 0xdb, 0x00, 0x04, 0x55, 0x66,
    0xff, 0xda, 0x00, 0x04, 0x01, 0x02,
    0x10, 0xff, 0x00, 0x20, 0xff, 0xd9,
  ]);

  assert.deepEqual(stripJpegMetadata(jpeg), Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x11, 0x22,
    0xff, 0xdb, 0x00, 0x04, 0x55, 0x66,
    0xff, 0xda, 0x00, 0x04, 0x01, 0x02,
    0x10, 0xff, 0x00, 0x20, 0xff, 0xd9,
  ]));
});

test('JPEG metadata stripping removes private segments between progressive scans', () => {
  const jpeg = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xda, 0x00, 0x04, 0x01, 0x02,
    0x10, 0xff, 0x00, 0x20,
    0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0xff, 0xda, 0x00, 0x04, 0x03, 0x04,
    0x30, 0x40, 0xff, 0xd9,
  ]);

  assert.deepEqual(stripJpegMetadata(jpeg), Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xda, 0x00, 0x04, 0x01, 0x02,
    0x10, 0xff, 0x00, 0x20,
    0xff, 0xda, 0x00, 0x04, 0x03, 0x04,
    0x30, 0x40, 0xff, 0xd9,
  ]));
});

test('JPEG metadata stripping fails closed for malformed or non-JPEG bytes', () => {
  assert.throws(
    () => stripJpegMetadata(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45])),
    /Malformed JPEG segment/
  );
  assert.throws(
    () => stripJpegMetadata(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])),
    /Expected JPEG bytes/
  );
});

test('PNG metadata stripping removes EXIF and text chunks without changing image chunks', () => {
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x01, 0x49, 0x48, 0x44, 0x52, 0x01, 0xaa, 0xaa, 0xaa, 0xaa,
    0x00, 0x00, 0x00, 0x02, 0x65, 0x58, 0x49, 0x66, 0x10, 0x11, 0xbb, 0xbb, 0xbb, 0xbb,
    0x00, 0x00, 0x00, 0x01, 0x74, 0x45, 0x58, 0x74, 0x20, 0xcc, 0xcc, 0xcc, 0xcc,
    0x00, 0x00, 0x00, 0x02, 0x49, 0x44, 0x41, 0x54, 0x30, 0x31, 0xdd, 0xdd, 0xdd, 0xdd,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xee, 0xee, 0xee, 0xee,
  ]);

  assert.deepEqual(stripImageMetadata(png), Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x01, 0x49, 0x48, 0x44, 0x52, 0x01, 0xaa, 0xaa, 0xaa, 0xaa,
    0x00, 0x00, 0x00, 0x02, 0x49, 0x44, 0x41, 0x54, 0x30, 0x31, 0xdd, 0xdd, 0xdd, 0xdd,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xee, 0xee, 0xee, 0xee,
  ]));
});

test('PNG metadata stripping fails closed on truncated chunks and unsupported images', () => {
  assert.throws(
    () => stripImageMetadata(Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x10, 0x49, 0x44, 0x41, 0x54,
    ])),
    /Malformed PNG chunk/
  );
  assert.throws(
    () => stripImageMetadata(Uint8Array.from([0x52, 0x49, 0x46, 0x46])),
    /Unsupported image format/
  );
});

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

test('keeps memory capabilities optional for older runtimes and validates enabled flags', async () => {
  const responses = [
    jsonResponse({
      classification: true,
      reasoned_local_analysis: true,
      retrieval_augmented_generation: false,
      knowledge_retrieval: true,
      local_similar_examples: true,
      ocr: false,
      batch_analysis: true,
    }),
    jsonResponse({
      classification: true,
      reasoned_local_analysis: true,
      retrieval_augmented_generation: false,
      knowledge_retrieval: true,
      local_similar_examples: true,
      ocr: false,
      batch_analysis: true,
      memory_write: true,
      memory_retrieval: false,
      memory_response: false,
    }),
  ];
  const api = createAiApi('https://ai.example.com', async () => responses.shift());

  assert.equal((await api.fetchCapabilities()).memory_write, undefined);
  assert.equal((await api.fetchCapabilities()).memory_write, true);
});

test('prepares and confirms memory with a durable idempotency key, then exports it', async () => {
  const intent = {
    action: 'create',
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
    action: 'create',
    intent_checksum: 'b'.repeat(64),
    policy_version: 'eisenhower-memory-consent-v1',
    confirmed_at: '2026-08-17T00:00:00Z',
    expires_at: '2026-08-17T00:05:00Z',
  };
  const requests = [];
  const responses = [
    jsonResponse({ action: 'create', memory_id: 'preference-1', receipt }),
    jsonResponse({ memory_id: 'preference-1', status: 'active', projection_state: 'synchronized' }),
    jsonResponse({
      items: [{
        memory_id: 'preference-1',
        memory_type: 'communication_preference',
        conflict_key: 'response-style',
        content: 'Prefer concise Polish responses',
        provenance: 'explicit web memory control',
        confidence: 1,
        salience: 0.8,
        retention_class: 'user_controlled',
        created_at: '2026-08-17T00:00:00Z',
        updated_at: '2026-08-17T00:00:00Z',
        expires_at: '2026-09-17T00:00:00Z',
        status: 'active',
        supersedes_id: null,
        superseded_by_id: null,
        consent_action: 'create',
        consent_policy_version: 'eisenhower-memory-consent-v1',
        consented_at: '2026-08-17T00:00:00Z',
      }],
    }),
  ];
  const api = createAiApi('https://ai.example.com', async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  });

  const prepared = await api.prepareMemory(intent);
  await api.confirmMemory(intent, prepared.receipt, 'memory-create-1');
  const exported = await api.exportMemory();

  assert.equal(exported.items[0].memory_id, 'preference-1');
  assert.equal(requests[0].url, 'https://ai.example.com/v2/memory/prepare');
  assert.deepEqual(JSON.parse(requests[0].init.body), intent);
  assert.equal(requests[1].url, 'https://ai.example.com/v2/memory/confirm');
  assert.equal(requests[1].init.headers['Idempotency-Key'], 'memory-create-1');
  assert.deepEqual(JSON.parse(requests[1].init.body), { intent, receipt });
  assert.equal(requests[2].url, 'https://ai.example.com/v2/memory/export');
});

test('bounds AI requests and maps timeouts to a business-safe error without changing task calls', async () => {
  let aiSignal;
  const ai = createAiApi('https://ai.example.com', {
    aiTimeoutMs: 5,
    fetch: async (_url, init) => {
      aiSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('implementation-specific abort details');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
  });

  await assert.rejects(() => ai.analyzeTask('slow task'), (error) => {
    assert.equal(error.code, 'request_timeout');
    assert.equal(error.message, 'Request timed out');
    return true;
  });
  assert.equal(aiSignal.aborted, true);

  const taskCalls = [];
  const task = createTaskApi('https://api.example.com', {
    aiTimeoutMs: 5,
    fetch: async (...args) => {
      taskCalls.push(args);
      return jsonResponse([], { headers: { get: () => null } });
    },
  });
  await task.listTasks();
  assert.equal(taskCalls[0][1]?.signal, undefined);
});

test('honours caller cancellation for AI requests and returns a stable cancellation code', async () => {
  const controller = new AbortController();
  const ai = createAiApi('https://ai.example.com', {
    aiTimeoutMs: 1000,
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('browser abort wording');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });

  const pending = ai.analyzeTask('cancelled task', 'en', { signal: controller.signal });
  controller.abort();

  await assert.rejects(() => pending, (error) => {
    assert.equal(error.code, 'request_cancelled');
    assert.equal(error.message, 'Request cancelled');
    return true;
  });
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
    jsonResponse({ status: 'connected', canConnect: true, connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' }, syncState: null, openConflicts: 1, pendingOutbox: 0, failedSyncCount: 0, syncProblem: false }),
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

test('starts and disconnects Google Calendar through authenticated business endpoints', async () => {
  const calls = [];
  const responses = [
    jsonResponse({ authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=safe' }, { status: 201 }),
    { ok: true, status: 204, json: async () => null },
  ];
  const api = createTaskApi('https://api.example.com', async (...args) => {
    calls.push(args);
    return responses.shift();
  });

  const started = await api.startCalendarConnection('/workspace?calendar=return');
  await api.disconnectCalendar();

  assert.equal(started.authorizationUrl, 'https://accounts.google.com/o/oauth2/auth?state=safe');
  assert.equal(calls[0][0], 'https://api.example.com/calendar/oauth/start');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { returnPath: '/workspace?calendar=return' });
  assert.equal(calls[1][0], 'https://api.example.com/calendar/oauth/disconnect');
  assert.equal(calls[1][1].method, 'POST');
});

test('lists selected calendar events and sends revision-safe manual link and import commands', async () => {
  const calls = [];
  const event = { id: 'event-1', etag: 'etag-1', title: 'Google event', start: '2026-08-20T12:00:00.000Z', end: '2026-08-20T12:30:00.000Z', timeZone: 'Europe/Warsaw' };
  const api = createTaskApi('https://api.example.com', async (...args) => {
    calls.push(args);
    const [url] = args;
    if (url.includes('/events?')) return jsonResponse({ events: [event] });
    if (url.endsWith('/bindings/preview')) return jsonResponse({
      task: { id: 'task-1', title: 'Local', revision: 2, schedule: null },
      event,
      googleToEisenhower: { title: event.title, schedule: { dueAt: event.start, timeZone: event.timeZone, durationMinutes: 30 } },
      eisenhowerToGoogle: { title: 'Local', schedule: null },
    });
    if (url.endsWith('/bindings')) return jsonResponse({ outcome: 'linked', taskId: 'task-1', taskRevision: 3 });
    return jsonResponse({ results: [{ providerEventId: 'event-2', status: 'imported', taskId: 'task-2' }] });
  });

  await api.listCalendarEvents('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
  await api.previewCalendarLink('task-1', 'event-1');
  await api.createCalendarLink({ taskId: 'task-1', providerEventId: 'event-1', providerEtag: 'etag-1', direction: 'google_to_eisenhower', taskRevision: 2, idempotencyKey: 'link-1' });
  await api.importCalendarEvents(['event-2'], 'import-1');

  assert.match(calls[0][0], /\/calendar\/events\?/);
  assert.deepEqual(JSON.parse(calls[1][1].body), { taskId: 'task-1', providerEventId: 'event-1' });
  assert.equal(calls[2][1].headers['If-Match'], '"2"');
  assert.equal(calls[2][1].headers['Idempotency-Key'], 'link-1');
  assert.equal(calls[3][1].headers['Idempotency-Key'], 'import-1');
  assert.deepEqual(JSON.parse(calls[3][1].body), { providerEventIds: ['event-2'] });
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
      args[0].includes('/delegated?') ? [taskFixture({ delegation })] : taskFixture({ delegation })
    );
  });

  const delegated = await api.listDelegatedTasks('completed');
  await api.updateTaskDelegation(
    'task/1',
    { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: 'Use the release runbook.' },
    4
  );
  await api.transitionTaskDelegation('task/1', 'accepted', 5);

  assert.equal(delegated[0].delegation.status, 'offered');
  assert.equal(calls[0][0], 'https://api.example.com/tasks/delegated?lifecycle=completed');
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
      reasoned_local_analysis: true,
      retrieval_augmented_generation: false,
      knowledge_retrieval: true,
      local_similar_examples: true,
      ocr: true,
      batch_analysis: true,
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
