import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import {
  CalendarBindingModel,
  CalendarConflictModel,
  CalendarConnectionModel,
  CalendarOutboxModel,
  CalendarSyncStateModel,
} from '../src/models/calendar';
import { TaskModel } from '../src/models/task';
import { clearMongo, startMongo, stopMongo } from './helpers/mongo';

const internalKey = 'calendar-internal-test-key-at-least-32-bytes';

function signed(requestPath: string, body: unknown, method = 'POST') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  const signature = createHmac('sha256', internalKey)
    .update(`v1\n${timestamp}\n${method}\n${requestPath}\n${rawBody}`)
    .digest('hex');
  return { timestamp, signature };
}

describe('calendar integration boundary', () => {
  const app = createApp({
    aiHealthChecker: async () => 'healthy',
    databaseStatusResolver: () => 'connected',
    calendarInternalHmacKey: internalKey,
  });
  const api = (path: string) => request(app).get(path).set('Authorization', 'Bearer test-api-token');

  beforeAll(startMongo);
  afterEach(clearMongo);
  afterAll(stopMongo);

  it('gets one owner-scoped task with its strong revision ETag', async () => {
    const task = await TaskModel.create({ title: 'Calendar seed' });
    const response = await api(`/tasks/${task.id}`);

    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe('"0"');
    expect(response.body._id).toBe(task.id);
  });

  it('persists provider-neutral connection, binding, sync cursor and watch without OAuth secrets', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google',
      calendarId: 'primary', credentialRef: 'n8n:credential:calendar-local', status: 'active',
    });
    const task = await TaskModel.create({ title: 'Bound task' });
    await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      taskId: task.id, providerEventId: 'event-1', providerEtag: 'etag-1',
      lastTaskRevision: 0, lastProviderRevision: 'etag-1',
    });
    await CalendarSyncStateModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      syncToken: 'sync-1', pageToken: 'page-2', fullResyncRequired: false,
      watch: { channelId: 'channel-1', resourceId: 'resource-1', expiresAt: new Date(Date.now() + 60_000) },
    });

    const stored = await CalendarConnectionModel.findById(connection.id).lean();
    expect(stored).not.toHaveProperty('accessToken');
    expect(stored).not.toHaveProperty('refreshToken');
    expect(await CalendarBindingModel.countDocuments()).toBe(1);
    expect(await CalendarSyncStateModel.findOne()).toMatchObject({ syncToken: 'sync-1', pageToken: 'page-2' });
  });

  it('authenticates an inbound command, marks 410 for full resync, and never deletes the task', async () => {
    const task = await TaskModel.create({ title: 'Keep me' });
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'n8n:credential:calendar-local', status: 'active',
    });
    await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id, taskId: task.id,
      providerEventId: 'event-delete', providerEtag: 'etag-1', lastTaskRevision: 0,
      lastProviderRevision: 'etag-1',
    });
    const path = '/internal/calendar/inbound';
    const body = {
      operationId: 'inbound-410-1', tenantId: 'local', ownerId: 'local-user',
      connectionId: connection.id, kind: 'sync_token_gone',
    };
    const auth = signed(path, body);
    const response = await request(app).post(path)
      .set('Content-Type', 'application/json')
      .set('X-Eisenhower-Timestamp', auth.timestamp)
      .set('X-Eisenhower-Signature', auth.signature)
      .send(body);

    expect(response.status).toBe(202);
    expect(await CalendarSyncStateModel.findOne({ connectionId: connection.id })).toMatchObject({
      fullResyncRequired: true,
    });
    expect(await TaskModel.findById(task.id)).not.toBeNull();
  });

  it('creates an explicit conflict when local and provider revisions both changed', async () => {
    const task = await TaskModel.create({ title: 'Locally changed', revision: 2 });
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'n8n:credential:calendar-local', status: 'active',
    });
    await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id, taskId: task.id,
      providerEventId: 'event-conflict', providerEtag: 'etag-old', lastTaskRevision: 1,
      lastProviderRevision: 'etag-old',
    });
    const path = '/internal/calendar/inbound';
    const body = {
      operationId: 'inbound-conflict-1', tenantId: 'local', ownerId: 'local-user',
      connectionId: connection.id, kind: 'event_changed', providerEventId: 'event-conflict',
      providerEtag: 'etag-new', title: 'Provider changed', dueAt: '2026-08-20T12:00:00.000Z',
      timeZone: 'Europe/Warsaw',
    };
    const auth = signed(path, body);
    const response = await request(app).post(path)
      .set('Content-Type', 'application/json')
      .set('X-Eisenhower-Timestamp', auth.timestamp)
      .set('X-Eisenhower-Signature', auth.signature)
      .send(body);

    expect(response.status).toBe(202);
    expect(response.body.outcome).toBe('conflict');
    expect(await CalendarConflictModel.countDocuments({ taskId: task.id, status: 'open' })).toBe(1);
    expect((await TaskModel.findById(task.id))?.title).toBe('Locally changed');
  });

  it('writes a schedule mutation and its outbound event atomically', async () => {
    const task = await TaskModel.create({ title: 'Schedule me' });
    const response = await request(app).put(`/tasks/${task.id}/schedule`)
      .set('Authorization', 'Bearer test-api-token')
      .set('If-Match', '"0"')
      .send({ schedule: { dueAt: '2026-08-20T12:00:00.000Z', timeZone: 'Europe/Warsaw' } });

    expect(response.status).toBe(200);
    expect(await CalendarOutboxModel.findOne({ aggregateId: task.id })).toMatchObject({
      type: 'event_create', aggregateRevision: 1, status: 'pending',
    });
  });

  it('represents paginated incremental sync checkpoints and final sync tokens', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'n8n:credential:calendar-local', status: 'active',
    });
    const path = '/internal/calendar/sync/apply';
    const first = {
      operationId: 'sync-page-1', tenantId: 'local', ownerId: 'local-user',
      connectionId: connection.id, kind: 'sync_checkpoint', nextPageToken: 'page-2',
    };
    const firstAuth = signed(path, first);
    const firstResponse = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', firstAuth.timestamp)
      .set('X-Eisenhower-Signature', firstAuth.signature).send(first);
    const final = {
      operationId: 'sync-page-2', tenantId: 'local', ownerId: 'local-user',
      connectionId: connection.id, kind: 'sync_checkpoint', nextSyncToken: 'sync-final',
    };
    const finalAuth = signed(path, final);
    const finalResponse = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', finalAuth.timestamp)
      .set('X-Eisenhower-Signature', finalAuth.signature).send(final);

    expect(firstResponse.status).toBe(202);
    expect(finalResponse.status).toBe(202);
    expect(await CalendarSyncStateModel.findOne({ connectionId: connection.id })).toMatchObject({
      syncToken: 'sync-final', fullResyncRequired: false,
    });
    expect((await CalendarSyncStateModel.findOne({ connectionId: connection.id }))?.pageToken).toBeUndefined();
  });

  it('exposes secret-free disconnected and connected user status and idempotent sync requests', async () => {
    const disconnected = await api('/calendar/status');
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'n8n:secret-reference-only', status: 'active',
    });
    const connected = await api('/calendar/status');
    const first = await request(app).post('/calendar/sync-requests')
      .set('Authorization', 'Bearer test-api-token').set('Idempotency-Key', 'ui-sync-1').send({});
    const replay = await request(app).post('/calendar/sync-requests')
      .set('Authorization', 'Bearer test-api-token').set('Idempotency-Key', 'ui-sync-1').send({});

    expect(disconnected.body).toEqual({ status: 'disconnected', connection: null });
    expect(connected.body.status).toBe('connected');
    expect(connected.body.connection).toEqual({ id: connection.id, provider: 'google', calendarId: 'primary' });
    expect(JSON.stringify(connected.body)).not.toContain('credentialRef');
    expect(first.status).toBe(202);
    expect(replay.body.eventId).toBe(first.body.eventId);
  });

  it('claims an executable provider dispatch enriched with connection and binding data', async () => {
    const task = await TaskModel.create({ title: 'Bound update', schedule: { dueAt: new Date('2026-08-20T12:00:00.000Z'), timeZone: 'Europe/Warsaw' } });
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'n8n:credential:google-1', status: 'active',
    });
    await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id, taskId: task.id,
      providerEventId: 'event-bound', providerEtag: 'etag-bound', lastTaskRevision: 0,
      lastProviderRevision: 'etag-bound',
    });
    await CalendarOutboxModel.create({
      eventId: 'dispatch-1', tenantId: 'local', ownerId: 'local-user', aggregateId: task.id,
      aggregateRevision: 1, type: 'event_update', payload: { taskId: task.id, title: task.title, schedule: task.schedule },
      status: 'pending',
    });
    const path = '/internal/calendar/outbox/claim';
    const body = {};
    const auth = signed(path, body);
    const response = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', auth.timestamp)
      .set('X-Eisenhower-Signature', auth.signature).send(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      eventId: 'dispatch-1', type: 'event_update',
      provider: { connectionId: connection.id, calendarId: 'primary', providerEventId: 'event-bound', providerEtag: 'etag-bound' },
    });
    expect(JSON.stringify(response.body)).not.toContain('credentialRef');
  });

  it('lists active reconciliation jobs with persisted cursors through the HMAC boundary', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'n8n:credential:google-1', status: 'active',
    });
    await CalendarSyncStateModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      syncToken: 'sync-existing', fullResyncRequired: false,
    });
    const path = '/internal/calendar/reconciliation/claim';
    const body = {};
    const auth = signed(path, body);
    const response = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', auth.timestamp)
      .set('X-Eisenhower-Signature', auth.signature).send(body);

    expect(response.status).toBe(200);
    expect(response.body.jobs).toEqual([expect.objectContaining({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      calendarId: 'primary', syncToken: 'sync-existing',
    })]);
    expect(JSON.stringify(response.body)).not.toContain('credentialRef');
  });

  it('resolves a valid Google signal to its scoped incremental-sync job', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'n8n:credential:google-1', status: 'active',
    });
    await CalendarSyncStateModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      syncToken: 'sync-current', fullResyncRequired: false,
      watch: { channelId: 'channel-1', resourceId: 'resource-1', expiresAt: new Date(Date.now() + 60_000) },
    });
    const path = '/internal/calendar/notifications/validate';
    const body = { channelId: 'channel-1', resourceId: 'resource-1', messageNumber: '42' };
    const auth = signed(path, body);
    const response = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', auth.timestamp)
      .set('X-Eisenhower-Signature', auth.signature).send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      valid: true, tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      calendarId: 'primary', syncToken: 'sync-current', signalId: 'channel-1:42',
    });
  });

});
