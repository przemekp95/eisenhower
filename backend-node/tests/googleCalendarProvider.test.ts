import request from 'supertest';
import { createApp } from '../src/app';
import {
  GoogleCalendarHttpAdapter, GoogleCalendarPort, GoogleCalendarService, loadGoogleCalendarConfig,
} from '../src/application/googleCalendar';
import { GoogleOAuthPort, GoogleTokenSet } from '../src/application/googleOAuth';
import { CalendarBindingModel, CalendarConnectionModel, CalendarOutboxModel, CalendarSyncStateModel, GoogleOAuthGrantModel } from '../src/models/calendar';
import { TaskModel } from '../src/models/task';
import mongoose from 'mongoose';
import { clearMongo, startMongo, stopMongo } from './helpers/mongo';
import { createHmac, randomUUID } from 'node:crypto';

class OAuthFake implements GoogleOAuthPort {
  expiresSoon = false;
  authorizationUrl({ state }: { state: string }) { return `https://accounts.test/auth?state=${state}`; }
  async exchangeCode(): Promise<GoogleTokenSet> { return { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: new Date(Date.now() + (this.expiresSoon ? 1 : 3600_000)), googleSubject: 'subject-1', scopes: ['openid', 'https://www.googleapis.com/auth/calendar.events'] }; }
  async revoke() {}
}
class CalendarFake implements GoogleCalendarPort {
  calls: Array<Record<string, unknown>> = [];
  async refresh(tokens: GoogleTokenSet) { this.calls.push({ kind: 'refresh' }); return { ...tokens, accessToken: 'rotated-access', expiresAt: new Date(Date.now() + 3600_000) }; }
  async createEvent(input: Record<string, unknown>) { this.calls.push({ kind: 'create', ...input }); return { providerEventId: String(input.deterministicId), providerEtag: 'etag-created' }; }
  async updateEvent(input: Record<string, unknown>) { this.calls.push({ kind: 'update', ...input }); return { providerEventId: String(input.providerEventId), providerEtag: 'etag-updated' }; }
  async deleteEvent(input: Record<string, unknown>) { this.calls.push({ kind: 'delete', ...input }); return { providerEventId: String(input.providerEventId), providerEtag: String(input.providerEtag) }; }
  async listChanges(input: Record<string, unknown>): ReturnType<GoogleCalendarPort['listChanges']> { this.calls.push({ kind: 'changes', ...input }); return { events: [{ id: 'historical-event' }], nextSyncToken: 'sync-next' }; }
  async watch(input: Record<string, unknown>) { this.calls.push({ kind: 'watch', ...input }); return { channelId: String(input.channelId), resourceId: 'resource-1', expiresAt: new Date(Date.now() + 3600_000) }; }
  async listEvents(input: Record<string, unknown>) {
    this.calls.push({ kind: 'list-events', ...input });
    return { events: [{ id: 'candidate-1', etag: 'etag-candidate', title: 'Candidate', start: '2026-08-20T12:00:00.000Z', end: '2026-08-20T12:30:00.000Z', timeZone: 'Europe/Warsaw' }] };
  }
  async getEvent(input: Record<string, unknown>) {
    this.calls.push({ kind: 'get-event', ...input });
    return { id: String(input.providerEventId), etag: 'etag-candidate', title: 'Candidate', start: '2026-08-20T12:00:00.000Z', end: '2026-08-20T12:30:00.000Z', timeZone: 'Europe/Warsaw' };
  }
}
const hmacKey = 'provider-internal-key-at-least-32-bytes';
function signed(path: string, body: unknown, requestId: string = randomUUID()) { const timestamp = String(Math.floor(Date.now() / 1000)); const raw = JSON.stringify(body); return { timestamp, requestId, signature: createHmac('sha256', hmacKey).update(`v1\n${timestamp}\n${requestId}\nPOST\n${path}\n${raw}`).digest('hex') }; }

describe('Google Calendar provider boundary', () => {
  const oauth = new OAuthFake();
  const calendar = new CalendarFake();
  const app = createApp({
    aiHealthChecker: async () => 'healthy', databaseStatusResolver: () => 'connected',
    calendarInternalHmacKey: hmacKey, googleOAuthPort: oauth, googleCalendarPort: calendar,
    googleOAuthConfig: { clientId: 'client', clientSecret: 'secret', callbackUrl: 'https://app.example.com/calendar/oauth/callback', encryptionKeys: { v1: Buffer.alloc(32, 9) }, currentKeyVersion: 'v1', returnOrigins: ['https://app.example.com'] },
    googleCalendarConfig: { watchCallbackUrls: ['https://hooks.example.com/google-calendar'] },
  });
  beforeAll(startMongo); afterEach(async () => { calendar.calls = []; oauth.expiresSoon = false; await clearMongo(); }); afterAll(stopMongo);

  async function connect(preserveStartup = false) {
    const start = await request(app).post('/calendar/oauth/start').set('Authorization', 'Bearer test-api-token').send({ returnPath: '/' });
    const state = new URL(start.body.authorizationUrl).searchParams.get('state')!;
    await request(app).get('/calendar/oauth/callback').query({ state, code: 'code' });
    const connection = await CalendarConnectionModel.findOne();
    if (!preserveStartup && connection) {
      await CalendarSyncStateModel.deleteOne({ connectionId: connection._id });
      await CalendarOutboxModel.deleteMany({ aggregateId: connection.id, type: 'calendar.sync.requested' });
      calendar.calls = [];
    }
    return connection;
  }
  async function post(path: string, body: Record<string, unknown>) { const auth = signed(path, body); return request(app).post(path).set('X-Eisenhower-Timestamp', auth.timestamp).set('X-Eisenhower-Request-Id', auth.requestId).set('X-Eisenhower-Signature', auth.signature).send(body); }

  it('resolves an outbox event through its own OAuth grant and returns no tokens', async () => {
    const connection = await connect();
    const status = await request(app).get('/calendar/status').set('Authorization', 'Bearer test-api-token');
    await CalendarOutboxModel.create({ eventId: 'out-1', tenantId: 'local', ownerId: 'local-user', aggregateId: 'task-1', aggregateRevision: 1, type: 'event_create', payload: { title: 'Task' }, status: 'pending' });
    const response = await post('/internal/calendar/provider/outbound', { eventId: 'out-1' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ providerEventId: expect.any(String), providerEtag: 'etag-created', connectionId: connection!.id });
    expect(JSON.stringify(response.body)).not.toContain('secret');
    expect(status.body).toMatchObject({ status: 'connected', canConnect: true });
  });

  it('registers watch immediately and seeds a no-import baseline after OAuth', async () => {
    const connection = await connect(true);
    const state = await CalendarSyncStateModel.findOne({ connectionId: connection!._id }).lean();
    const startup = await CalendarOutboxModel.findOne({
      aggregateId: connection!.id,
      type: 'calendar.sync.requested',
    }).lean();

    expect(calendar.calls).toContainEqual(expect.objectContaining({ kind: 'watch', calendarId: 'primary' }));
    expect(state).toMatchObject({
      fullResyncRequired: true,
      watch: {
        channelId: expect.any(String),
        resourceId: 'resource-1',
        verificationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(startup).toMatchObject({ status: 'pending' });

    const baseline = await post('/internal/calendar/provider/changes', {
      connectionId: connection!.id,
      checkpoint: 'full-resync',
    });
    expect(baseline.body).toEqual({ events: [], nextSyncToken: 'sync-next' });
  });

  it('marks the initial sync for recovery when immediate watch registration fails', async () => {
    const watch = jest.spyOn(calendar, 'watch').mockRejectedValueOnce(new Error('watch offline'));
    const connection = await connect(true);

    expect(watch).toHaveBeenCalled();
    expect(await CalendarSyncStateModel.findOne({ connectionId: connection!._id })).toMatchObject({
      fullResyncRequired: true,
    });
  });

  it('lists bounded candidates, previews a unique link and imports only selected events', async () => {
    const connection = await connect();
    const task = await TaskModel.create({
      title: 'Local task',
      schedule: { dueAt: new Date('2026-08-21T10:00:00.000Z'), timeZone: 'UTC', durationMinutes: 60 },
    });
    const auth = { Authorization: 'Bearer test-api-token' };
    const candidates = await request(app)
      .get('/calendar/events')
      .query({ timeMin: '2026-08-01T00:00:00.000Z', timeMax: '2026-09-01T00:00:00.000Z' })
      .set(auth);
    const preview = await request(app)
      .post('/calendar/bindings/preview')
      .set(auth)
      .send({ taskId: task.id, providerEventId: 'candidate-1' });
    const linked = await request(app)
      .post('/calendar/bindings')
      .set(auth)
      .set('If-Match', '"0"')
      .set('Idempotency-Key', 'manual-link-1')
      .send({
        taskId: task.id,
        providerEventId: 'candidate-1',
        providerEtag: 'etag-candidate',
        direction: 'google_to_eisenhower',
      });
    const imported = await request(app)
      .post('/calendar/imports')
      .set(auth)
      .set('Idempotency-Key', 'selected-import-1')
      .send({ providerEventIds: ['candidate-2'] });
    const replay = await request(app)
      .post('/calendar/imports')
      .set(auth)
      .set('Idempotency-Key', 'selected-import-1')
      .send({ providerEventIds: ['candidate-2'] });

    expect(connection).toBeDefined();
    expect(candidates.body.events).toEqual([expect.objectContaining({ id: 'candidate-1' })]);
    expect(preview.body).toMatchObject({
      task: { id: task.id, revision: 0 },
      event: { id: 'candidate-1', etag: 'etag-candidate' },
    });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({ outcome: 'linked', taskRevision: 1 });
    expect(await CalendarBindingModel.findOne({ taskId: task.id })).toMatchObject({
      providerEventId: 'candidate-1',
    });
    expect(imported.body.results).toEqual([
      expect.objectContaining({ providerEventId: 'candidate-2', status: 'imported' }),
    ]);
    expect(replay.body).toEqual(imported.body);
    expect(await TaskModel.countDocuments({ title: 'Candidate' })).toBe(2);
  });

  it('fails closed across candidate, manual-link and selected-import edge cases', async () => {
    const connection = await connect();
    const auth = { Authorization: 'Bearer test-api-token' };
    const events = (query = '') => request(app).get(`/calendar/events${query}`).set(auth);
    expect((await events()).status).toBe(400);
    expect((await events('?timeMin=2026-09-01T00:00:00.000Z&timeMax=2026-08-01T00:00:00.000Z')).status).toBe(400);
    expect((await events('?timeMin=2026-01-01T00:00:00.000Z&timeMax=2027-01-01T00:00:00.000Z')).status).toBe(400);
    expect((await events('?timeMin=2026-08-01T00:00:00.000Z&timeMax=2026-09-01T00:00:00.000Z&pageToken=next')).status).toBe(200);
    expect(calendar.calls.at(-1)).toMatchObject({ kind: 'list-events', pageToken: 'next' });
    const originalListEvents = calendar.listEvents.bind(calendar);
    calendar.listEvents = async () => { throw new Error('candidate read failed'); };
    expect((await events('?timeMin=2026-08-01T00:00:00.000Z&timeMax=2026-09-01T00:00:00.000Z')).status).toBe(500);
    calendar.listEvents = originalListEvents;

    expect((await request(app).post('/calendar/bindings/preview').set(auth).send({})).status).toBe(400);
    expect((await request(app).post('/calendar/bindings/preview').set(auth).send({ taskId: new TaskModel().id, providerEventId: 'missing' })).status).toBe(409);
    const legacyPreviewTask = await TaskModel.create({ title: 'Legacy preview' });
    await TaskModel.collection.updateOne({ _id: legacyPreviewTask._id }, { $unset: { revision: '', schedule: '' } });
    expect((await request(app).post('/calendar/bindings/preview').set(auth)
      .send({ taskId: legacyPreviewTask.id, providerEventId: 'legacy-preview' })).body.task)
      .toMatchObject({ revision: 0, schedule: null });
    const invalidIntervalTask = await TaskModel.create({ title: 'Invalid interval target' });
    const originalGetEventForPreview = calendar.getEvent.bind(calendar);
    calendar.getEvent = async (input) => ({
      ...(await originalGetEventForPreview(input)),
      end: '2026-08-20T11:00:00.000Z',
    });
    expect((await request(app).post('/calendar/bindings/preview').set(auth).send({ taskId: invalidIntervalTask.id, providerEventId: 'invalid-interval' })).status).toBe(500);
    calendar.getEvent = originalGetEventForPreview;

    const noSchedule = await TaskModel.create({ title: 'No schedule' });
    const command = {
      taskId: noSchedule.id,
      providerEventId: 'candidate-local',
      providerEtag: 'etag-candidate',
      direction: 'eisenhower_to_google',
    };
    const bindingRequest = (body: Record<string, unknown>, revision = 0, key = 'edge-link') => request(app)
      .post('/calendar/bindings').set(auth).set('If-Match', `"${revision}"`)
      .set('Idempotency-Key', key).send(body);
    expect((await request(app).post('/calendar/bindings').set(auth).send(command)).status).toBe(428);
    expect((await bindingRequest({}, 0, 'invalid-body')).status).toBe(400);
    expect((await bindingRequest({ ...command, providerEtag: 'stale' }, 0, 'stale-provider')).status).toBe(412);
    expect((await bindingRequest(command, 1, 'stale-task')).status).toBe(412);
    expect((await bindingRequest(command, 0, 'missing-schedule')).status).toBe(409);
    expect((await bindingRequest({ ...command, taskId: new TaskModel().id }, 0, 'missing-task')).status).toBe(409);

    const scheduled = await TaskModel.create({
      title: 'Scheduled local',
      schedule: { dueAt: new Date('2026-08-21T10:00:00.000Z'), timeZone: 'UTC', durationMinutes: 60 },
    });
    const localCommand = { ...command, taskId: scheduled.id, providerEventId: 'candidate-local-success' };
    const local = await bindingRequest(localCommand, 0, 'local-link');
    const replay = await bindingRequest(localCommand, 0, 'local-link');
    const reused = await bindingRequest({ ...localCommand, direction: 'google_to_eisenhower' }, 0, 'local-link');
    expect(local.status).toBe(201);
    expect(replay.body).toEqual(local.body);
    expect(reused.status).toBe(409);
    expect(await CalendarOutboxModel.findOne({ eventId: 'manual-link:local-link' })).toMatchObject({ type: 'event_update' });
    expect((await request(app).post('/calendar/bindings/preview').set(auth).send({ taskId: scheduled.id, providerEventId: 'another' })).status).toBe(409);
    const duplicateLinkTask = await TaskModel.create({ title: 'Duplicate link target' });
    expect((await bindingRequest({ ...localCommand, taskId: duplicateLinkTask.id }, 0, 'duplicate-link')).status).toBe(409);

    const legacyLinkTask = await TaskModel.create({ title: 'Legacy link' });
    await TaskModel.collection.updateOne({ _id: legacyLinkTask._id }, { $unset: { revision: '' } });
    const legacyLinked = await bindingRequest({
      ...localCommand,
      taskId: legacyLinkTask.id,
      providerEventId: 'legacy-link',
      direction: 'google_to_eisenhower',
    }, 0, 'legacy-link');
    expect(legacyLinked.body).toMatchObject({ outcome: 'linked', taskRevision: 1 });

    const legacyLocalTask = await TaskModel.create({
      title: 'Legacy local link',
      schedule: { dueAt: new Date('2026-08-21T10:00:00.000Z'), timeZone: 'UTC', durationMinutes: 30 },
    });
    await TaskModel.collection.updateOne({ _id: legacyLocalTask._id }, { $unset: { revision: '' } });
    const legacyLocal = await bindingRequest({
      ...localCommand,
      taskId: legacyLocalTask.id,
      providerEventId: 'legacy-local-link',
    }, 0, 'legacy-local-link');
    expect(legacyLocal.body).toMatchObject({ outcome: 'linked', taskRevision: 0 });

    const incompleteTask = await TaskModel.create({ title: 'Incomplete transaction' });
    const startSession = jest.spyOn(CalendarConnectionModel, 'startSession').mockResolvedValueOnce({
      withTransaction: async () => undefined,
      endSession: async () => undefined,
    } as never);
    expect((await bindingRequest({ ...localCommand, taskId: incompleteTask.id, providerEventId: 'incomplete' }, 0, 'incomplete')).status).toBe(500);
    startSession.mockRestore();

    const duplicateTask = await TaskModel.create({ title: 'Already bound' });
    await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection!._id,
      taskId: duplicateTask._id, providerEventId: 'duplicate-import', providerEtag: 'etag-candidate',
      lastTaskRevision: 0, lastProviderRevision: 'etag-candidate',
    });
    expect((await request(app).post('/calendar/imports').set(auth).send({ providerEventIds: ['x'] })).status).toBe(428);
    for (const ids of [[], Array.from({ length: 21 }, (_, index) => `e-${index}`), ['']]) {
      expect((await request(app).post('/calendar/imports').set(auth).set('Idempotency-Key', 'invalid-import').send({ providerEventIds: ids })).status).toBe(400);
    }
    const originalGetEvent = calendar.getEvent.bind(calendar);
    calendar.getEvent = async (input) => {
      if (input.providerEventId === 'failed-import') throw new Error('provider read failed');
      if (input.providerEventId === 'unknown-import') throw 'non-error rejection';
      return originalGetEvent(input);
    };
    const partial = await request(app).post('/calendar/imports').set(auth)
      .set('Idempotency-Key', 'partial-import')
      .send({ providerEventIds: ['duplicate-import', 'failed-import'] });
    expect(partial.body.results).toEqual([
      { providerEventId: 'duplicate-import', status: 'duplicate' },
      { providerEventId: 'failed-import', status: 'failed', error: 'provider read failed' },
    ]);
    expect((await request(app).post('/calendar/imports').set(auth)
      .set('Idempotency-Key', 'unknown-import').send({ providerEventIds: ['unknown-import'] })).body.results)
      .toEqual([{ providerEventId: 'unknown-import', status: 'failed', error: 'unknown' }]);

    const legacyImportedId = new mongoose.Types.ObjectId();
    const createTask = jest.spyOn(TaskModel, 'create').mockResolvedValueOnce([{
      _id: legacyImportedId,
      id: legacyImportedId.toString(),
      title: 'Legacy imported task',
    }] as never);
    expect((await request(app).post('/calendar/imports').set(auth)
      .set('Idempotency-Key', 'legacy-import').send({ providerEventIds: ['legacy-import'] })).body.results)
      .toEqual([{ providerEventId: 'legacy-import', status: 'imported', taskId: legacyImportedId.toString() }]);
    createTask.mockRestore();

    calendar.getEvent = async () => { throw new Error('unexpected link failure'); };
    const unexpectedTask = await TaskModel.create({ title: 'Unexpected link failure' });
    expect((await bindingRequest({ ...localCommand, taskId: unexpectedTask.id, providerEventId: 'unexpected' }, 0, 'unexpected')).status).toBe(500);
    calendar.getEvent = originalGetEvent;

    await GoogleOAuthGrantModel.deleteOne({ _id: connection!.credentialRef.slice('oauth-grant:'.length) });
    expect((await request(app).post('/calendar/imports').set(auth)
      .set('Idempotency-Key', 'missing-grant-import').send({ providerEventIds: ['x'] })).status).toBe(500);
    expect((await bindingRequest({ ...localCommand, taskId: new TaskModel().id }, 0, 'missing-grant-link')).status).toBe(500);
    connection!.status = 'revoked';
    await connection!.save();
    expect((await request(app).post('/calendar/imports').set(auth)
      .set('Idempotency-Key', 'disconnected-import').send({ providerEventIds: ['x'] })).status).toBe(409);
    expect((await events('?timeMin=2026-08-01T00:00:00.000Z&timeMax=2026-09-01T00:00:00.000Z')).status).toBe(409);
    expect((await bindingRequest({ ...localCommand, taskId: new TaskModel().id }, 0, 'disconnected-link')).status).toBe(409);
  });

  it('maps a candidate-resolution disconnect race and a post-watch disconnect safely', async () => {
    const connection = await connect();
    const findOne = jest.spyOn(CalendarConnectionModel, 'findOne')
      .mockResolvedValueOnce(connection as never)
      .mockResolvedValueOnce(null as never);
    const candidates = await request(app).get('/calendar/events')
      .query({ timeMin: '2026-08-01T00:00:00.000Z', timeMax: '2026-09-01T00:00:00.000Z' })
      .set('Authorization', 'Bearer test-api-token');
    expect(candidates.status).toBe(409);
    findOne.mockRestore();

    const service = new GoogleCalendarService(
      { clientId: 'client', clientSecret: 'secret', callbackUrl: 'https://app.example.com/calendar/oauth/callback', encryptionKeys: { v1: Buffer.alloc(32, 9) }, currentKeyVersion: 'v1', returnOrigins: ['https://app.example.com'] },
      { watchCallbackUrls: ['https://hooks.example.com/google-calendar'] },
      calendar,
    );
    const watch = jest.spyOn(calendar, 'watch').mockImplementationOnce(async (input) => {
      await CalendarConnectionModel.deleteOne({ _id: connection!._id });
      return { channelId: String(input.channelId), resourceId: 'resource-1', expiresAt: new Date(Date.now() + 3600_000) };
    });
    await expect(service.registerWatch(connection!.id)).rejects.toThrow('calendar_connection_unavailable');
    watch.mockRestore();
  });

  it('uses only the persisted checkpoint and rejects revoked or malformed requests', async () => {
    const connection = await connect();
    await CalendarSyncStateModel.create({ tenantId: 'local', ownerId: 'local-user', connectionId: connection!.id, syncToken: 'sync-current', fullResyncRequired: false });
    const changed = await post('/internal/calendar/provider/changes', { connectionId: connection!.id, checkpoint: 'sync-current' });
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({ events: [{ id: 'historical-event' }], nextSyncToken: 'sync-next' });
    expect(calendar.calls.at(-1)).toMatchObject({ syncToken: 'sync-current' });
    connection!.status = 'revoked'; await connection!.save();
    expect((await post('/internal/calendar/provider/changes', { connectionId: connection!.id, checkpoint: 'sync-current' })).status).toBe(409);
    expect((await post('/internal/calendar/provider/outbound', {})).status).toBe(400);
  });

  it('replays a cached provider response without repeating the external side effect', async () => {
    const connection = await connect();
    await CalendarSyncStateModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection!.id,
      syncToken: 'sync-current', fullResyncRequired: false,
    });
    const path = '/internal/calendar/provider/changes';
    const body = { connectionId: connection!.id, checkpoint: 'sync-current' };
    const auth = signed(path, body, 'provider-changes-retry');
    const send = () => request(app).post(path)
      .set('X-Eisenhower-Timestamp', auth.timestamp)
      .set('X-Eisenhower-Request-Id', auth.requestId)
      .set('X-Eisenhower-Signature', auth.signature)
      .send(body);

    const first = await send();
    const replay = await send();

    expect(first.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(calendar.calls.filter((call) => call.kind === 'changes')).toHaveLength(1);
  });

  it('permits an explicitly claimed full resync without accepting arbitrary checkpoints', async () => {
    const connection = await connect();

    const changed = await post('/internal/calendar/provider/changes', { connectionId: connection!.id, checkpoint: 'full-resync' });

    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({ events: [], nextSyncToken: 'sync-next' });
    expect(calendar.calls.at(-1)).toMatchObject({ kind: 'changes', calendarId: 'primary' });
    expect(calendar.calls.at(-1)).not.toHaveProperty('syncToken');
    expect((await post('/internal/calendar/provider/changes', { connectionId: connection!.id, checkpoint: 'invented' })).status).toBe(409);
  });

  it('fails closed when a connection points at another user grant', async () => {
    const connectionA = await connect();
    const connectionB = await CalendarConnectionModel.create({
      tenantId: 'tenant-b', ownerId: 'user-b', provider: 'google', calendarId: 'primary-b',
      credentialRef: connectionA!.credentialRef, status: 'active',
    });
    const response = await post('/internal/calendar/provider/watch', {
      connectionId: connectionB.id, address: 'https://hooks.example.com/google-calendar',
    });
    expect(response.status).toBe(409);
    expect(calendar.calls).toEqual([]);
  });

  it('refreshes an expired grant once and persists a newly encrypted token set', async () => {
    oauth.expiresSoon = true;
    await connect(true);
    const before = await GoogleOAuthGrantModel.findOne().select('+tokenCiphertext').lean();
    await CalendarOutboxModel.create({ eventId: 'refresh-event', tenantId: 'local', ownerId: 'local-user', aggregateId: 'task-refresh', aggregateRevision: 1, type: 'event_create', payload: { title: 'Task' }, status: 'pending' });
    const response = await post('/internal/calendar/provider/outbound', { eventId: 'refresh-event' });
    const after = await GoogleOAuthGrantModel.findOne().select('+tokenCiphertext').lean();
    expect(response.status).toBe(200);
    expect(calendar.calls.filter((call) => call.kind === 'refresh')).toHaveLength(1);
    expect(after?.tokenCiphertext).toBe(before?.tokenCiphertext);
    expect(JSON.stringify(response.body)).not.toContain('rotated-access');
  });

  it('allows only configured HTTPS watch callbacks and never returns channel token', async () => {
    const connection = await connect();
    const allowed = await post('/internal/calendar/provider/watch', { connectionId: connection!.id, address: 'https://hooks.example.com/google-calendar' });
    const denied = await post('/internal/calendar/provider/watch', { connectionId: connection!.id, address: 'https://evil.example/hook' });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({
      channelId: expect.any(String), resourceId: 'resource-1', expiresAt: expect.any(String),
      verificationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(allowed.body)).not.toContain('token');
    expect(denied.status).toBe(400);
  });

  it('HTTP adapter URL-encodes identifiers, sends If-Match and retries one 429', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'event/id', etag: 'etag-new' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const adapter = new GoogleCalendarHttpAdapter();
    const result = await adapter.updateEvent({
      accessToken: 'token', calendarId: 'calendar/id', providerEventId: 'event/id',
      providerEtag: 'etag-old', payload: { title: 'Task', schedule: { dueAt: '2026-08-20T12:00:00.000Z', timeZone: 'Europe/Warsaw' } },
    });
    expect(result).toEqual({ providerEventId: 'event/id', providerEtag: 'etag-new' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toContain('calendar%2Fid/events/event%2Fid');
    expect((fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)['If-Match']).toBe('etag-old');
  });

  it('maps task duration and reminder to a non-zero Google event interval', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'created', etag: 'etag-created' }), { status: 200 }),
    );
    const adapter = new GoogleCalendarHttpAdapter();

    await adapter.createEvent({
      accessToken: 'token',
      calendarId: 'work',
      deterministicId: 'stable-id',
      payload: {
        title: 'Plan release',
        schedule: {
          dueAt: '2026-08-20T12:00:00.000Z',
          timeZone: 'Europe/Warsaw',
          durationMinutes: 45,
          remindAt: '2026-08-20T11:30:00.000Z',
        },
      },
    });

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      start: { dateTime: '2026-08-20T12:00:00.000Z', timeZone: 'Europe/Warsaw' },
      end: { dateTime: '2026-08-20T12:45:00.000Z', timeZone: 'Europe/Warsaw' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
    });
  });

  it('lists bounded timed events, omits unsupported all-day items and fetches one event', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [
          { id: 'one', etag: 'e1', summary: '  One  ', start: { dateTime: '2026-08-20T12:00:00.000Z', timeZone: 'Europe/Warsaw' }, end: { dateTime: '2026-08-20T12:30:00.000Z' } },
          { id: 'two', etag: 'e2', start: { dateTime: '2026-08-21T12:00:00.000Z' }, end: { dateTime: '2026-08-21T13:00:00.000Z', timeZone: 'UTC' } },
          { id: 'all-day', etag: 'e3', start: { date: '2026-08-22' }, end: { date: '2026-08-23' } },
        ],
        nextPageToken: 'next-page',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'event/id', etag: 'etag-one', summary: '',
        start: { dateTime: '2026-08-22T12:00:00.000Z' },
        end: { dateTime: '2026-08-22T12:05:00.000Z' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    const adapter = new GoogleCalendarHttpAdapter();

    await expect(adapter.listEvents({
      accessToken: 'token', calendarId: 'calendar/id',
      timeMin: '2026-08-01T00:00:00.000Z', timeMax: '2026-09-01T00:00:00.000Z',
      pageToken: 'page/1',
    })).resolves.toEqual({
      events: [
        { id: 'one', etag: 'e1', title: 'One', start: '2026-08-20T12:00:00.000Z', end: '2026-08-20T12:30:00.000Z', timeZone: 'Europe/Warsaw' },
        { id: 'two', etag: 'e2', title: 'Google Calendar event', start: '2026-08-21T12:00:00.000Z', end: '2026-08-21T13:00:00.000Z', timeZone: 'UTC' },
      ],
      nextPageToken: 'next-page',
    });
    expect(String(fetchSpy.mock.calls[0][0])).toContain('pageToken=page%2F1');
    await expect(adapter.getEvent({ accessToken: 'token', calendarId: 'calendar/id', providerEventId: 'event/id' }))
      .resolves.toMatchObject({ id: 'event/id', title: 'Google Calendar event', timeZone: 'UTC' });
    await expect(adapter.listEvents({ accessToken: 'token', calendarId: 'c' }))
      .resolves.toEqual({ events: [] });
    await expect(adapter.listEvents({ accessToken: 'token', calendarId: 'c' }))
      .rejects.toThrow('google_calendar_events_failed');
    await expect(adapter.getEvent({ accessToken: 'token', calendarId: 'c', providerEventId: 'e' }))
      .rejects.toThrow('google_calendar_event_failed');
  });

  it('honors a bounded Retry-After delay before the single retry', async () => {
    const timer = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void) => {
      callback(); return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '5' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'created', etag: 'etag' }), { status: 200 }));
    await expect(new GoogleCalendarHttpAdapter().createEvent({ accessToken: 'a', calendarId: 'c', deterministicId: 'i', payload: {} }))
      .resolves.toEqual({ providerEventId: 'created', providerEtag: 'etag' });
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 1000);
  });

  it('stops after the one allowed retry when Google remains unavailable', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));

    await expect(new GoogleCalendarHttpAdapter().createEvent({
      accessToken: 'a', calendarId: 'c', deterministicId: 'i', payload: {},
    })).rejects.toThrow('google_calendar_write_failed');
  });

  it('maps Google 410 changes to a controlled reset result', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 410 }));
    const result = await new GoogleCalendarHttpAdapter().listChanges({
      accessToken: 'token', calendarId: 'primary', syncToken: 'expired-sync',
    });
    expect(result).toEqual({ events: [], resetRequired: true });
  });

  it('loads and validates watch callback configuration', () => {
    expect(loadGoogleCalendarConfig({})).toBeNull();
    expect(loadGoogleCalendarConfig({ GOOGLE_CALENDAR_WATCH_CALLBACK_URLS: ' https://a.example/hook,https://b.example/hook ' }))
      .toEqual({ watchCallbackUrls: ['https://a.example/hook', 'https://b.example/hook'] });
    expect(() => loadGoogleCalendarConfig({ GOOGLE_CALENDAR_WATCH_CALLBACK_URLS: 'http://a.example/hook' })).toThrow('exact HTTPS');
    expect(() => new GoogleCalendarService(
      { clientId: 'i', clientSecret: 's', callbackUrl: 'https://a/cb', encryptionKeys: { v1: Buffer.alloc(32) }, currentKeyVersion: 'v1', returnOrigins: ['https://a'] },
      { watchCallbackUrls: ['http://unsafe'] }, calendar,
    )).toThrow('must use HTTPS');
  });

  it('covers Calendar HTTP create, delete, changes, watch and refresh contracts', async () => {
    const adapter = new GoogleCalendarHttpAdapter();
    const fetchSpy = jest.spyOn(global, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'created', etag: 'etag' }), { status: 200 }));
    await expect(adapter.createEvent({ accessToken: 'a', calendarId: 'c', deterministicId: 'id', payload: {} }))
      .resolves.toEqual({ providerEventId: 'created', providerEtag: 'etag' });
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(adapter.deleteEvent({ accessToken: 'a', calendarId: 'c', providerEventId: 'e', providerEtag: 'tag' }))
      .resolves.toEqual({ providerEventId: 'e', providerEtag: 'tag' });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 1 }], nextPageToken: 'p', nextSyncToken: 's' }), { status: 200 }));
    await expect(adapter.listChanges({ accessToken: 'a', calendarId: 'c', pageToken: 'old-p', syncToken: 'old-s' }))
      .resolves.toEqual({ events: [{ id: 1 }], nextPageToken: 'p', nextSyncToken: 's' });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'channel', resourceId: 'resource', expiration: String(Date.now() + 1000) }), { status: 200 }));
    await expect(adapter.watch({ accessToken: 'a', calendarId: 'c', channelId: 'channel', address: 'https://a/hook', channelToken: 'secret' }))
      .resolves.toMatchObject({ channelId: 'channel', resourceId: 'resource' });
    const tokens = { accessToken: 'old', refreshToken: 'refresh', expiresAt: new Date(), googleSubject: 'sub', scopes: ['openid'] };
    const oauthConfig = { clientId: 'i', clientSecret: 's', callbackUrl: 'https://a/cb', encryptionKeys: { v1: Buffer.alloc(32) }, currentKeyVersion: 'v1', returnOrigins: ['https://a'] };
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new', expires_in: 5, scope: 'openid calendar' }), { status: 200 }));
    await expect(adapter.refresh(tokens, oauthConfig)).resolves.toMatchObject({ accessToken: 'new', scopes: ['openid', 'calendar'] });
  });

  it.each([
    ['delete', () => new GoogleCalendarHttpAdapter().deleteEvent({ accessToken: 'a', calendarId: 'c', providerEventId: 'e', providerEtag: 't' }), 'delete_failed'],
    ['changes', () => new GoogleCalendarHttpAdapter().listChanges({ accessToken: 'a', calendarId: 'c' }), 'changes_failed'],
    ['watch', () => new GoogleCalendarHttpAdapter().watch({ accessToken: 'a', calendarId: 'c', channelId: 'i', address: 'https://a', channelToken: 't' }), 'watch_failed'],
  ])('fails closed for unsuccessful Google %s', async (_name, invoke, message) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 400 }));
    await expect(invoke()).rejects.toThrow(message);
  });

  it('fails closed for malformed writes, watches and refreshes', async () => {
    const adapter = new GoogleCalendarHttpAdapter();
    const fetchSpy = jest.spyOn(global, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await expect(adapter.createEvent({ accessToken: 'a', calendarId: 'c', deterministicId: 'i', payload: {} })).rejects.toThrow('write_incomplete');
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await expect(adapter.watch({ accessToken: 'a', calendarId: 'c', channelId: 'i', address: 'https://a', channelToken: 't' })).rejects.toThrow('watch_incomplete');
    await expect(adapter.refresh({ accessToken: 'a', expiresAt: new Date(), googleSubject: 's', scopes: [] }, { clientId: 'i', clientSecret: 's', callbackUrl: 'https://a', encryptionKeys: {}, currentKeyVersion: 'v', returnOrigins: [] })).rejects.toThrow('refresh_token_missing');
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 400 }));
    await expect(adapter.refresh({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(), googleSubject: 's', scopes: [] }, { clientId: 'i', clientSecret: 's', callbackUrl: 'https://a', encryptionKeys: {}, currentKeyVersion: 'v', returnOrigins: [] })).rejects.toThrow('refresh_failed');
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await expect(adapter.refresh({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(), googleSubject: 's', scopes: [] }, { clientId: 'i', clientSecret: 's', callbackUrl: 'https://a', encryptionKeys: {}, currentKeyVersion: 'v', returnOrigins: [] })).rejects.toThrow('refresh_incomplete');
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new' }), { status: 200 }));
    await expect(adapter.refresh({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(), googleSubject: 's', scopes: ['old'] }, { clientId: 'i', clientSecret: 's', callbackUrl: 'https://a', encryptionKeys: {}, currentKeyVersion: 'v', returnOrigins: [] }))
      .resolves.toMatchObject({ scopes: ['old'] });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await expect(adapter.listChanges({ accessToken: 'a', calendarId: 'c' })).resolves.toEqual({ events: [] });
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 400 }));
    await expect(adapter.createEvent({ accessToken: 'a', calendarId: 'c', deterministicId: 'i', payload: {} })).rejects.toThrow('write_failed');
  });

  it('covers update/delete dispatch and provider route error mapping', async () => {
    const connection = await connect();
    const taskId = new mongoose.Types.ObjectId();
    await CalendarBindingModel.create({ tenantId: 'local', ownerId: 'local-user', connectionId: connection!.id, taskId, providerEventId: 'event', providerEtag: 'etag', lastTaskRevision: 0, lastProviderRevision: 'etag' });
    await CalendarOutboxModel.create([
      { eventId: 'update-1', tenantId: 'local', ownerId: 'local-user', aggregateId: taskId.toString(), aggregateRevision: 1, type: 'event_update', payload: {}, status: 'pending' },
      { eventId: 'delete-1', tenantId: 'local', ownerId: 'local-user', aggregateId: taskId.toString(), aggregateRevision: 2, type: 'event_delete', payload: {}, status: 'pending' },
    ]);
    expect((await post('/internal/calendar/provider/outbound', { eventId: 'update-1' })).status).toBe(200);
    expect((await post('/internal/calendar/provider/outbound', { eventId: 'delete-1' })).status).toBe(200);
    expect((await post('/internal/calendar/provider/outbound', { eventId: 'missing' })).status).toBe(409);
    expect((await post('/internal/calendar/provider/changes', { connectionId: connection!.id, checkpoint: 'wrong' })).status).toBe(409);
    calendar.listChanges = async () => { throw new Error('unexpected'); };
    await CalendarSyncStateModel.create({ tenantId: 'local', ownerId: 'local-user', connectionId: connection!.id, syncToken: 'right', fullResyncRequired: false });
    expect((await post('/internal/calendar/provider/changes', { connectionId: connection!.id, checkpoint: 'right' })).status).toBe(500);
  });

  it('rejects malformed provider route bodies and unavailable dispatch state', async () => {
    expect((await post('/internal/calendar/provider/outbound', { eventId: '' })).status).toBe(400);
    expect((await post('/internal/calendar/provider/outbound', { eventId: 'x', extra: true })).status).toBe(400);
    expect((await post('/internal/calendar/provider/changes', { connectionId: 1, checkpoint: 'x' })).status).toBe(400);
    expect((await post('/internal/calendar/provider/changes', { connectionId: 'x', checkpoint: 'x', extra: true })).status).toBe(400);
    expect((await post('/internal/calendar/provider/watch', { connectionId: 'x' })).status).toBe(400);
    expect((await post('/internal/calendar/provider/watch', { connectionId: 'x', address: 'https://a', extra: true })).status).toBe(400);
    await CalendarOutboxModel.create({ eventId: 'unsupported', tenantId: 'local', ownerId: 'local-user', aggregateId: 'x', aggregateRevision: 0, type: 'other', payload: {}, status: 'pending' });
    expect((await post('/internal/calendar/provider/outbound', { eventId: 'unsupported' })).status).toBe(409);
    await CalendarOutboxModel.create({ eventId: 'no-connection', tenantId: 'nobody', ownerId: 'nobody', aggregateId: 'x', aggregateRevision: 0, type: 'event_create', payload: {}, status: 'pending' });
    expect((await post('/internal/calendar/provider/outbound', { eventId: 'no-connection' })).status).toBe(409);
  });

  it('rejects provider requests with no parsed body', async () => {
    const emptyPost = (path: string) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const requestId = randomUUID();
      const signature = createHmac('sha256', hmacKey)
        .update(`v1\n${timestamp}\n${requestId}\nPOST\n${path}\n`)
        .digest('hex');
      return request(app).post(path)
        .set('X-Eisenhower-Timestamp', timestamp)
        .set('X-Eisenhower-Request-Id', requestId)
        .set('X-Eisenhower-Signature', signature);
    };

    expect((await emptyPost('/internal/calendar/provider/outbound')).status).toBe(400);
    expect((await emptyPost('/internal/calendar/provider/changes')).status).toBe(400);
    expect((await emptyPost('/internal/calendar/provider/watch')).status).toBe(400);
  });

  it('fails closed for missing grant keys and binding/connection mismatches', async () => {
    const connection = await connect();
    const grant = await GoogleOAuthGrantModel.findOne();
    grant!.keyVersion = 'removed'; await grant!.save();
    expect((await post('/internal/calendar/provider/watch', { connectionId: connection!.id, address: 'https://hooks.example.com/google-calendar' })).status).toBe(409);
    grant!.keyVersion = 'v1'; await grant!.save();
    const taskId = new mongoose.Types.ObjectId();
    await CalendarBindingModel.create({ tenantId: 'local', ownerId: 'local-user', connectionId: new mongoose.Types.ObjectId(), taskId, providerEventId: 'e', providerEtag: 't', lastTaskRevision: 0, lastProviderRevision: 't' });
    await CalendarOutboxModel.create({ eventId: 'binding-mismatch', tenantId: 'local', ownerId: 'local-user', aggregateId: taskId.toString(), aggregateRevision: 1, type: 'event_update', payload: {}, status: 'pending' });
    expect((await post('/internal/calendar/provider/outbound', { eventId: 'binding-mismatch' })).status).toBe(409);
  });

  it('supports initial full-resync and page-token checkpoints without importing baseline events', async () => {
    const connection = await connect();
    const checkpoints: Array<Record<string, unknown>> = [];
    calendar.listChanges = async (input) => {
      checkpoints.push(input);
      return { events: [{ id: 'historical' }], ...(input.pageToken ? { nextSyncToken: 'done' } : { nextPageToken: 'page-2' }) };
    };
    expect((await post('/internal/calendar/provider/changes', { connectionId: connection!.id, checkpoint: 'full-resync' })).body)
      .toEqual({ events: [], nextSyncToken: 'done' });
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[1]).toMatchObject({ pageToken: 'page-2' });
  });

  it('drains incremental pages in one bounded request and fails closed on a runaway cursor', async () => {
    const connection = await connect();
    await CalendarSyncStateModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection!.id,
      syncToken: 'sync-current', fullResyncRequired: false,
    });
    calendar.listChanges = async (input) => input.pageToken
      ? { events: [{ id: 'second' }], nextSyncToken: 'sync-final' }
      : { events: [{ id: 'first' }], nextPageToken: 'page-2' };

    const drained = await post('/internal/calendar/provider/changes', {
      connectionId: connection!.id, checkpoint: 'sync-current',
    });
    expect(drained).toMatchObject({
      status: 200,
      body: { events: [{ id: 'first' }, { id: 'second' }], nextSyncToken: 'sync-final' },
    });

    let page = 0;
    calendar.listChanges = async () => ({ events: [], nextPageToken: `page-${++page}` });
    const runaway = await post('/internal/calendar/provider/changes', {
      connectionId: connection!.id, checkpoint: 'sync-current',
    });
    expect(runaway).toMatchObject({
      status: 500, body: { error: 'google_calendar_changes_page_limit_exceeded' },
    });
  });

  it('returns a controlled provider reset and rejects a page without a checkpoint', async () => {
    const connection = await connect();
    await CalendarSyncStateModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection!.id,
      syncToken: 'sync-current', fullResyncRequired: false,
    });
    calendar.listChanges = async () => ({ events: [], resetRequired: true });
    const reset = await post('/internal/calendar/provider/changes', {
      connectionId: connection!.id, checkpoint: 'sync-current',
    });
    calendar.listChanges = async () => ({ events: [] });
    const incomplete = await post('/internal/calendar/provider/changes', {
      connectionId: connection!.id, checkpoint: 'sync-current',
    });

    expect(reset).toMatchObject({ status: 200, body: { events: [], resetRequired: true } });
    expect(incomplete).toMatchObject({
      status: 500, body: { error: 'google_calendar_changes_checkpoint_missing' },
    });
  });
});
