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
  sanitizeOcrFile,
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

const jpegWithPrivateMetadata = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda, 0x00, 0x04,
  0x01, 0x02, 0x10, 0x20, 0xff, 0xd9,
]);

const jpegWithoutPrivateMetadata = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x10, 0x20, 0xff, 0xd9,
]);

const pngWithPrivateMetadata = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x01, 0x49, 0x48, 0x44, 0x52,
  0x01, 0xaa, 0xaa, 0xaa, 0xaa, 0x00, 0x00, 0x00, 0x02, 0x65, 0x58, 0x49, 0x66, 0x10, 0x11, 0xbb,
  0xbb, 0xbb, 0xbb, 0x00, 0x00, 0x00, 0x02, 0x49, 0x44, 0x41, 0x54, 0x30, 0x31, 0xdd, 0xdd, 0xdd,
  0xdd, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xee, 0xee, 0xee, 0xee,
]);

const pngWithoutPrivateMetadata = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x01, 0x49, 0x48, 0x44, 0x52,
  0x01, 0xaa, 0xaa, 0xaa, 0xaa, 0x00, 0x00, 0x00, 0x02, 0x49, 0x44, 0x41, 0x54, 0x30, 0x31, 0xdd,
  0xdd, 0xdd, 0xdd, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xee, 0xee, 0xee, 0xee,
]);

function readFileBytes(file: File): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
    reader.readAsArrayBuffer(file);
  });
}

const asciiBytes = (value: string) => Array.from(value, (character) => character.charCodeAt(0));

describe('OCR file privacy', () => {
  it('removes private JPEG metadata before the browser upload boundary', async () => {
    const original = new File([jpegWithPrivateMetadata], 'camera.jpg', {
      type: 'image/jpeg',
      lastModified: 123,
    });

    const sanitized = await sanitizeOcrFile(original);

    expect(sanitized).not.toBe(original);
    expect(sanitized.name).toBe('camera-sanitized.jpg');
    expect(sanitized.type).toBe('image/jpeg');
    await expect(readFileBytes(sanitized)).resolves.toEqual(Array.from(jpegWithoutPrivateMetadata));
  });

  it('passes non-image text through and rejects unsupported image formats', async () => {
    const text = new File(['Task'], 'tasks.txt', { type: 'text/plain' });
    await expect(sanitizeOcrFile(text)).resolves.toBe(text);
    await expect(
      sanitizeOcrFile(new File(['RIFF'], 'camera.webp', { type: 'image/webp' }))
    ).rejects.toThrow('Unsupported image format');
  });

  it('derives the sanitized content type from bytes instead of trusting picker metadata', async () => {
    const mislabeled = new File([jpegWithPrivateMetadata], 'camera.png', { type: 'image/png' });

    const sanitized = await sanitizeOcrFile(mislabeled);

    expect(sanitized.name).toBe('camera-sanitized.jpg');
    expect(sanitized.type).toBe('image/jpeg');
  });

  it('sanitizes JPEG bytes when the browser provides no MIME type', async () => {
    const original = new File([jpegWithPrivateMetadata], 'camera.jpg');

    const sanitized = await sanitizeOcrFile(original);

    expect(sanitized).not.toBe(original);
    expect(sanitized.type).toBe('image/jpeg');
    await expect(readFileBytes(sanitized)).resolves.toEqual(Array.from(jpegWithoutPrivateMetadata));
  });

  it('sanitizes PNG metadata and supplies a safe basename when none remains', async () => {
    const original = new File([pngWithPrivateMetadata], '.png', { type: 'image/png' });

    const sanitized = await sanitizeOcrFile(original);

    expect(sanitized.name).toBe('scan-sanitized.png');
    expect(sanitized.type).toBe('image/png');
    await expect(readFileBytes(sanitized)).resolves.toEqual(Array.from(pngWithoutPrivateMetadata));
  });

  it('rejects malformed image bytes even when the file claims to be text', async () => {
    const malformedJpeg = new File(
      [Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45])],
      'scan.txt',
      { type: 'text/plain' }
    );
    const disguisedWebp = new File(
      [Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])],
      'tasks.txt',
      { type: 'text/plain' }
    );

    await expect(sanitizeOcrFile(malformedJpeg)).rejects.toThrow('Malformed JPEG segment');
    await expect(sanitizeOcrFile(disguisedWebp)).rejects.toThrow('Unsupported image format');
  });

  it('passes valid text containing an ftyp token through unchanged', async () => {
    const text = new File(['1234ftyp task'], 'tasks.txt', { type: 'text/plain' });

    await expect(sanitizeOcrFile(text)).resolves.toBe(text);
  });

  it.each([
    ['PNG', [0x89, 0x50, 0x4e, 0x47]],
    ['GIF87a', asciiBytes('GIF87a')],
    ['GIF89a', asciiBytes('GIF89a')],
    ['BMP', asciiBytes('BM')],
    ['WebP', asciiBytes('RIFFxxxxWEBP')],
    ['AVIF', [0x00, 0x00, 0x00, 0x0c, ...asciiBytes('ftypmsf1')]],
  ])('rejects a malformed %s signature even when it is labeled as text', async (_name, bytes) => {
    const disguisedImage = new File([Uint8Array.from(bytes)], 'tasks.txt', {
      type: 'text/plain',
    });

    await expect(sanitizeOcrFile(disguisedImage)).rejects.toThrow('Unsupported image format');
  });

  it.each([
    [Uint8Array.from([0x00, 0x00, 0x00, 0x08, ...asciiBytes('ftyp')])],
    [Uint8Array.from([0x00, 0x00, 0x00, 0x0c, ...asciiBytes('nopeavif')])],
    [Uint8Array.from([0x00, 0x00, 0x00, 0x0c, ...asciiBytes('ftypnope')])],
  ])('does not treat an invalid ISO-BMFF header as an image signature', async (bytes) => {
    const text = new File([bytes], 'tasks.txt', { type: 'text/plain' });

    await expect(sanitizeOcrFile(text)).rejects.toThrow('Unsupported image format');
  });

  it.each([new DOMException('read failed'), null])(
    'rejects when the browser cannot read image bytes (error: %s)',
    async (readerError) => {
      const readSpy = jest
        .spyOn(FileReader.prototype, 'readAsArrayBuffer')
        .mockImplementation(function () {
          Object.defineProperty(this, 'error', { configurable: true, value: readerError });
          this.onerror?.(new ProgressEvent('error'));
        });

      await expect(
        sanitizeOcrFile(new File(['Task'], 'tasks.txt', { type: 'text/plain' }))
      ).rejects.toThrow(readerError ?? 'Unable to read image bytes');
      readSpy.mockRestore();
    }
  );

  it('rejects when the browser returns a non-binary image result', async () => {
    const readSpy = jest
      .spyOn(FileReader.prototype, 'readAsArrayBuffer')
      .mockImplementation(function () {
        Object.defineProperty(this, 'result', { configurable: true, value: 'not binary' });
        this.onload?.(new ProgressEvent('load'));
      });

    await expect(
      sanitizeOcrFile(new File(['Task'], 'tasks.txt', { type: 'text/plain' }))
    ).rejects.toThrow('Unable to read image bytes');
    readSpy.mockRestore();
  });

  it.each([new DOMException('text read failed'), null])(
    'fails closed when browser text fallback cannot be read (error: %s)',
    async (readerError) => {
      const textReadSpy = jest
        .spyOn(FileReader.prototype, 'readAsText')
        .mockImplementation(function () {
          Object.defineProperty(this, 'error', { configurable: true, value: readerError });
          this.onerror?.(new ProgressEvent('error'));
        });
      const text = new File(['Task'], 'tasks.txt', { type: 'text/plain' });

      await expect(sanitizeOcrFile(text)).rejects.toThrow('Unsupported image format');
      textReadSpy.mockRestore();
    }
  );

  it('fails closed when the browser returns a non-string text result', async () => {
    const textReadSpy = jest
      .spyOn(FileReader.prototype, 'readAsText')
      .mockImplementation(function () {
        Object.defineProperty(this, 'result', { configurable: true, value: new ArrayBuffer(0) });
        this.onload?.(new ProgressEvent('load'));
      });
    const text = new File(['Task'], 'tasks.txt', { type: 'text/plain' });

    await expect(sanitizeOcrFile(text)).rejects.toThrow('Unsupported image format');
    textReadSpy.mockRestore();
  });
});

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
