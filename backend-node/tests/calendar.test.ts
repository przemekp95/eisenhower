import { createHash, createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../src/app';
import { CalendarApplicationService } from '../src/application/calendar';
import { createCalendarRouter } from '../src/routes/calendar';
import { isCalendarInboundCommand } from '../src/routes/calendarInternal';
import {
  CalendarBindingModel,
  CalendarConflictModel,
  CalendarConnectionModel,
  CalendarInternalRequestReceiptModel,
  CalendarMutationReceiptModel,
  CalendarOutboxModel,
  CalendarSyncStateModel,
} from '../src/models/calendar';
import { TaskModel } from '../src/models/task';
import { clearMongo, startMongo, stopMongo } from './helpers/mongo';

const internalKey = 'calendar-internal-test-key-at-least-32-bytes';

function signed(requestPath: string, body: unknown, method = 'POST') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = randomUUID();
  const rawBody = JSON.stringify(body) ?? '';
  const signature = createHmac('sha256', internalKey)
    .update(`v1\n${timestamp}\n${requestId}\n${method}\n${requestPath}\n${rawBody}`)
    .digest('hex');
  return { timestamp, requestId, signature };
}

function signedWithRequestId(requestPath: string, body: unknown, requestId: string, method = 'POST') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body) ?? '';
  const signature = createHmac('sha256', internalKey)
    .update(`v1\n${timestamp}\n${requestId}\n${method}\n${requestPath}\n${rawBody}`)
    .digest('hex');
  return { timestamp, requestId, signature };
}

describe('calendar integration boundary', () => {
  it('defines indexes matching scoped conflict and connection queries', () => {
    expect(CalendarConnectionModel.schema.indexes()).toContainEqual([
      { tenantId: 1, ownerId: 1, status: 1 },
      expect.any(Object),
    ]);
    expect(CalendarConflictModel.schema.indexes()).toContainEqual([
      { tenantId: 1, ownerId: 1, status: 1, createdAt: 1 },
      expect.any(Object),
    ]);
    expect(CalendarConflictModel.schema.indexes()).toContainEqual([
      { tenantId: 1, ownerId: 1, connectionId: 1, status: 1 },
      expect.any(Object),
    ]);
    expect(CalendarOutboxModel.schema.indexes()).toContainEqual([
      { tenantId: 1, ownerId: 1, status: 1 },
      expect.any(Object),
    ]);
  });
  const app = createApp({
    aiHealthChecker: async () => 'healthy',
    databaseStatusResolver: () => 'connected',
    calendarInternalHmacKey: internalKey,
    rateLimitLimit: 1_000,
  });
  const api = (path: string) => request(app).get(path).set('Authorization', 'Bearer test-api-token');

  beforeAll(startMongo);
  afterEach(async () => {
    await clearMongo();
    jest.restoreAllMocks();
  });
  afterAll(stopMongo);

  it('gets one owner-scoped task with its strong revision ETag', async () => {
    expect(createCalendarRouter()).toBeDefined();
    expect(isCalendarInboundCommand('not-an-object')).toBe(false);
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
      watch: { channelId: 'channel-1', resourceId: 'resource-1', verificationHash: createHash('sha256').update('secret-1').digest('hex'), expiresAt: new Date(Date.now() + 60_000) },
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
      .set('X-Eisenhower-Request-Id', auth.requestId)
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
      .set('X-Eisenhower-Request-Id', auth.requestId)
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
      .set('X-Eisenhower-Request-Id', firstAuth.requestId)
      .set('X-Eisenhower-Signature', firstAuth.signature).send(first);
    const final = {
      operationId: 'sync-page-2', tenantId: 'local', ownerId: 'local-user',
      connectionId: connection.id, kind: 'sync_checkpoint', nextSyncToken: 'sync-final',
    };
    const finalAuth = signed(path, final);
    const finalResponse = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', finalAuth.timestamp)
      .set('X-Eisenhower-Request-Id', finalAuth.requestId)
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
    await CalendarOutboxModel.create({
      eventId: 'failed-business-sync', tenantId: 'local', ownerId: 'local-user',
      aggregateId: connection.id, aggregateRevision: 0, type: 'calendar.sync.requested',
      payload: { connectionId: connection.id }, status: 'dead_letter', attempts: 5,
      lastError: 'private_runtime_detail',
    });
    const connected = await api('/calendar/status');
    const first = await request(app).post('/calendar/sync-requests')
      .set('Authorization', 'Bearer test-api-token').set('Idempotency-Key', 'ui-sync-1').send({});
    const replay = await request(app).post('/calendar/sync-requests')
      .set('Authorization', 'Bearer test-api-token').set('Idempotency-Key', 'ui-sync-1').send({});

    expect(disconnected.body).toEqual({ status: 'disconnected', connection: null, canConnect: false });
    expect(connected.body.status).toBe('connected');
    expect(connected.body.connection).toEqual({ id: connection.id, provider: 'google', calendarId: 'primary' });
    expect(connected.body.canConnect).toBe(false);
    expect(connected.body).toMatchObject({ syncProblem: true, failedSyncCount: 1 });
    expect(JSON.stringify(connected.body)).not.toContain('credentialRef');
    expect(JSON.stringify(connected.body)).not.toContain('private_runtime_detail');
    expect(first.status).toBe(202);
    expect(replay.body.eventId).toBe(first.body.eventId);
    expect(await CalendarOutboxModel.findOne({ eventId: first.body.eventId })).toMatchObject({
      type: 'calendar.sync.requested',
      payload: { connectionId: connection.id },
    });
    expect((await CalendarSyncStateModel.findOne({ connectionId: connection.id }))?.lastRequestedAt).toBeDefined();
    expect(await CalendarOutboxModel.findOne({ eventId: 'failed-business-sync' }).lean()).toMatchObject({
      status: 'pending', attempts: 0,
    });
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
      .set('X-Eisenhower-Request-Id', auth.requestId)
      .set('X-Eisenhower-Signature', auth.signature).send(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      eventId: 'dispatch-1', type: 'event_update',
      provider: { connectionId: connection.id, calendarId: 'primary', providerEventId: 'event-bound', providerEtag: 'etag-bound' },
    });
    expect(JSON.stringify(response.body)).not.toContain('credentialRef');
  });

  it('binds a durable request id to HMAC and returns the identical outbox claim on replay', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'n8n:credential:google-replay', status: 'active',
    });
    for (const eventId of ['dispatch-replay-1', 'dispatch-replay-2']) {
      await CalendarOutboxModel.create({
        eventId, tenantId: 'local', ownerId: 'local-user', aggregateId: connection.id,
        aggregateRevision: 0, type: 'calendar.sync.requested', payload: { connectionId: connection.id },
        status: 'pending',
      });
    }
    const path = '/internal/calendar/outbox/claim';
    const body = {};
    const auth = signedWithRequestId(path, body, 'claim-retry-after-lost-response');
    const send = () => request(app).post(path)
      .set('X-Eisenhower-Timestamp', auth.timestamp)
      .set('X-Eisenhower-Request-Id', auth.requestId)
      .set('X-Eisenhower-Signature', auth.signature)
      .send(body);

    const first = await send();
    const replay = await send();

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(await CalendarOutboxModel.countDocuments({ status: 'leased' })).toBe(1);
    expect(await CalendarOutboxModel.findOne({ eventId: 'dispatch-replay-2' })).toMatchObject({
      status: 'pending', attempts: 0,
    });
  });

  it('leases only one event for concurrent replays of the same signed claim', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'n8n:credential:google-concurrent-replay', status: 'active',
    });
    for (const eventId of ['dispatch-concurrent-1', 'dispatch-concurrent-2']) {
      await CalendarOutboxModel.create({
        eventId, tenantId: 'local', ownerId: 'local-user', aggregateId: connection.id,
        aggregateRevision: 0, type: 'calendar.sync.requested', payload: { connectionId: connection.id },
        status: 'pending',
      });
    }
    const path = '/internal/calendar/outbox/claim';
    const body = {};
    const auth = signedWithRequestId(path, body, 'claim-concurrent-replay');
    const send = () => request(app).post(path)
      .set('X-Eisenhower-Timestamp', auth.timestamp)
      .set('X-Eisenhower-Request-Id', auth.requestId)
      .set('X-Eisenhower-Signature', auth.signature)
      .send(body);

    const [first, replay] = await Promise.all([send(), send()]);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(await CalendarOutboxModel.countDocuments({ status: 'leased' })).toBe(1);
    expect(await CalendarOutboxModel.countDocuments({ status: 'pending', attempts: 0 })).toBe(1);
  });

  it('rejects a missing request id even when the legacy HMAC is otherwise valid', async () => {
    const path = '/internal/calendar/status';
    const body = {};
    const auth = signed(path, body);
    const response = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', auth.timestamp)
      .set('X-Eisenhower-Signature', auth.signature)
      .send(body);

    expect(response).toMatchObject({
      status: 401,
      body: { error: 'Invalid calendar dispatch request id' },
    });
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
      .set('X-Eisenhower-Request-Id', auth.requestId)
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
      watch: { channelId: 'channel-1', resourceId: 'resource-1', verificationHash: createHash('sha256').update('channel-secret').digest('hex'), expiresAt: new Date(Date.now() + 60_000) },
    });
    const path = '/internal/calendar/notifications/validate';
    const body = { channelId: 'channel-1', resourceId: 'resource-1', channelToken: 'channel-secret', messageNumber: '42' };
    const auth = signed(path, body);
    const response = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', auth.timestamp)
      .set('X-Eisenhower-Request-Id', auth.requestId)
      .set('X-Eisenhower-Signature', auth.signature).send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      valid: true, tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      calendarId: 'primary', syncToken: 'sync-current', signalId: 'channel-1:42',
    });
  });

  it('reclaims expired leases and dead-letters a failed final attempt', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    await CalendarOutboxModel.create({
      eventId: 'expired-lease', tenantId: 'local', ownerId: 'local-user',
      aggregateId: connection.id, aggregateRevision: 0, type: 'calendar.sync.requested',
      payload: { connectionId: connection.id }, status: 'leased', attempts: 4,
      leaseId: 'expired-worker',
      leaseUntil: new Date(Date.now() - 1_000),
    });

    const reclaimed = await internalPost('/internal/calendar/outbox/claim', {});
    const activeLease = await CalendarOutboxModel.findOne({ eventId: 'expired-lease' }).lean();
    const stale = await internalPost('/internal/calendar/outbox/acknowledge', {
      eventId: 'expired-lease', leaseId: 'expired-worker', delivered: true,
    });
    const failed = await internalPost('/internal/calendar/outbox/acknowledge', {
      eventId: 'expired-lease', leaseId: reclaimed.body.leaseId,
      delivered: false, error: 'provider_dispatch_failed',
    });

    expect(reclaimed.body).toMatchObject({
      eventId: 'expired-lease', type: 'calendar.sync.requested', checkpoint: 'full-resync',
    });
    expect(reclaimed.body.leaseId).not.toBe('expired-worker');
    expect(activeLease?.leaseUntil?.getTime()).toBeGreaterThan(Date.now() + 34 * 60_000);
    expect(stale.status).toBe(409);
    expect(failed.body).toMatchObject({
      status: 'dead_letter', attempts: 5, lastError: 'provider_dispatch_failed',
    });
  });

  it('rejects a wrong watch token and non-monotonic Google message numbers', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    await CalendarSyncStateModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      syncToken: 'sync-current', fullResyncRequired: false,
      watch: {
        channelId: 'channel-secure', resourceId: 'resource-secure',
        verificationHash: 'placeholder', lastMessageNumber: 41,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await CalendarSyncStateModel.updateOne(
      { connectionId: connection.id },
      { $set: { 'watch.verificationHash': createHash('sha256').update('expected-token').digest('hex') } },
    );

    const wrongToken = await internalPost('/internal/calendar/notifications/validate', {
      channelId: 'channel-secure', resourceId: 'resource-secure',
      channelToken: 'wrong-token', messageNumber: '42',
    });
    const accepted = await internalPost('/internal/calendar/notifications/validate', {
      channelId: 'channel-secure', resourceId: 'resource-secure',
      channelToken: 'expected-token', messageNumber: '42',
    });
    const replay = await internalPost('/internal/calendar/notifications/validate', {
      channelId: 'channel-secure', resourceId: 'resource-secure',
      channelToken: 'expected-token', messageNumber: '42',
    });

    expect(wrongToken).toMatchObject({ status: 403, body: { valid: false } });
    expect(accepted).toMatchObject({ status: 200, body: { valid: true, signalId: 'channel-secure:42' } });
    expect(replay).toMatchObject({ status: 409, body: { valid: false, reason: 'message_replayed' } });
  });

  async function internalPost(path: string, body?: object) {
    const auth = signed(path, body);
    return request(app).post(path)
      .set('X-Eisenhower-Timestamp', auth.timestamp)
      .set('X-Eisenhower-Request-Id', auth.requestId)
      .set('X-Eisenhower-Signature', auth.signature)
      .send(body);
  }

  it('rejects invalid internal timestamps, signatures, and inbound shapes', async () => {
    const path = '/internal/calendar/inbound';
    const body = {};
    const invalidTimestamp = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', 'not-a-time')
      .set('X-Eisenhower-Signature', '0'.repeat(64)).send(body);
    const stale = signed(path, body);
    const staleTimestamp = String(Number(stale.timestamp) - 301);
    const staleSignature = createHmac('sha256', internalKey)
      .update(`v1\n${staleTimestamp}\nPOST\n${path}\n{}`)
      .digest('hex');
    const staleResponse = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', staleTimestamp)
      .set('X-Eisenhower-Signature', staleSignature).send(body);
    const malformedSignature = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', stale.timestamp)
      .set('X-Eisenhower-Request-Id', stale.requestId)
      .set('X-Eisenhower-Signature', 'nope').send(body);
    const wrongSignature = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', stale.timestamp)
      .set('X-Eisenhower-Request-Id', stale.requestId)
      .set('X-Eisenhower-Signature', '0'.repeat(64)).send(body);
    const invalidBody = await internalPost(path, body);

    expect(invalidTimestamp.status).toBe(401);
    expect(staleResponse.status).toBe(401);
    expect(malformedSignature.status).toBe(401);
    expect(wrongSignature.status).toBe(401);
    expect(invalidBody.status).toBe(400);
  });

  it('fails closed for reused, pending, and unavailable internal request receipts', async () => {
    const path = '/internal/calendar/status';
    const firstBody = {};
    const requestId = 'receipt-reuse-different-body';
    const firstAuth = signedWithRequestId(path, firstBody, requestId);
    const first = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', firstAuth.timestamp)
      .set('X-Eisenhower-Request-Id', requestId)
      .set('X-Eisenhower-Signature', firstAuth.signature).send(firstBody);
    const secondBody = { changed: true };
    const secondAuth = signedWithRequestId(path, secondBody, requestId);
    const reused = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', secondAuth.timestamp)
      .set('X-Eisenhower-Request-Id', requestId)
      .set('X-Eisenhower-Signature', secondAuth.signature).send(secondBody);

    const pendingBody = {};
    const pendingId = 'receipt-still-processing';
    const pendingFingerprint = createHash('sha256')
      .update(`POST\n${path}\n${JSON.stringify(pendingBody)}`)
      .digest('hex');
    await CalendarInternalRequestReceiptModel.create({
      requestId: pendingId,
      fingerprint: pendingFingerprint,
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const pendingAuth = signedWithRequestId(path, pendingBody, pendingId);
    const pending = await request(app).post(path)
      .set('X-Eisenhower-Timestamp', pendingAuth.timestamp)
      .set('X-Eisenhower-Request-Id', pendingId)
      .set('X-Eisenhower-Signature', pendingAuth.signature).send(pendingBody);

    jest.spyOn(CalendarInternalRequestReceiptModel, 'create').mockRejectedValueOnce(
      new Error('receipt storage unavailable') as never,
    );
    const unavailable = await internalPost(path, {});

    expect(first.status).toBe(404);
    expect(reused).toMatchObject({ status: 409, body: { error: 'calendar_request_id_reused' } });
    expect(pending).toMatchObject({ status: 409, body: { error: 'calendar_request_in_progress' } });
    expect(unavailable).toMatchObject({ status: 500, body: { error: 'receipt storage unavailable' } });
  });

  it('replays an empty completed claim and tolerates receipt completion logging failure', async () => {
    const path = '/internal/calendar/outbox/claim';
    const body = {};
    const requestId = 'empty-claim-completed-replay';
    const auth = signedWithRequestId(path, body, requestId);
    const send = () => request(app).post(path)
      .set('X-Eisenhower-Timestamp', auth.timestamp)
      .set('X-Eisenhower-Request-Id', requestId)
      .set('X-Eisenhower-Signature', auth.signature).send(body);

    const first = await send();
    const replay = await send();
    jest.spyOn(CalendarInternalRequestReceiptModel, 'updateOne').mockRejectedValueOnce(
      new Error('completion logging unavailable') as never,
    );
    const loggingFailureResponse = await internalPost('/internal/calendar/status', {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(first.status).toBe(204);
    expect(replay.status).toBe(204);
    expect(loggingFailureResponse.status).toBe(404);
  });

  it('rejects idempotency key reuse with a different inbound or sync request', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const first = {
      operationId: 'reused-operation', tenantId: 'local', ownerId: 'local-user',
      connectionId: connection.id, kind: 'sync_token_gone',
    };
    const second = { ...first, connectionId: new TaskModel().id };
    expect((await internalPost('/internal/calendar/inbound', first)).status).toBe(202);
    expect((await internalPost('/internal/calendar/inbound', first)).body).toMatchObject({
      outcome: 'full_resync_required',
    });
    expect((await internalPost('/internal/calendar/inbound', second)).status).toBe(409);

    await CalendarMutationReceiptModel.deleteMany({});
    const sync = await request(app).post('/calendar/sync-requests')
      .set('Authorization', 'Bearer test-api-token').set('Idempotency-Key', 'sync-reuse').send({});
    expect(sync.status).toBe(202);
    await CalendarMutationReceiptModel.updateOne(
      { operationId: 'sync-reuse' }, { $set: { fingerprint: 'different' } },
    );
    const reused = await request(app).post('/calendar/sync-requests')
      .set('Authorization', 'Bearer test-api-token').set('Idempotency-Key', 'sync-reuse').send({});
    expect(reused.status).toBe(409);
  });

  it('covers ignored, deleted, rejected-checkpoint and applied inbound outcomes', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const base = { tenantId: 'local', ownerId: 'local-user', connectionId: connection.id };
    const missingCheckpoint = await internalPost('/internal/calendar/sync/apply', {
      ...base, operationId: 'checkpoint-missing', kind: 'sync_checkpoint',
    });
    const missingBinding = await internalPost('/internal/calendar/inbound', {
      ...base, operationId: 'binding-missing', kind: 'event_deleted',
      providerEventId: 'absent', providerEtag: 'etag-2',
    });
    const task = await TaskModel.create({ title: 'Original' });
    const binding = await CalendarBindingModel.create({
      ...base, taskId: task.id, providerEventId: 'bound', providerEtag: 'etag-1',
      lastTaskRevision: 0, lastProviderRevision: 'etag-1',
    });
    const deleted = await internalPost('/internal/calendar/inbound', {
      ...base, operationId: 'provider-deleted', kind: 'event_deleted',
      providerEventId: 'bound', providerEtag: 'etag-2',
    });
    const missingTaskBinding = await CalendarBindingModel.create({
      ...base, taskId: new TaskModel().id, providerEventId: 'orphan', providerEtag: 'etag-1',
      lastTaskRevision: 0, lastProviderRevision: 'etag-1',
    });
    const missingTask = await internalPost('/internal/calendar/inbound', {
      ...base, operationId: 'task-missing', kind: 'event_changed', providerEventId: 'orphan',
      providerEtag: 'etag-2', title: 'Ignored', dueAt: '2026-08-20T12:00:00.000Z',
      timeZone: 'Europe/Warsaw',
    });
    const applied = await internalPost('/internal/calendar/inbound', {
      ...base, operationId: 'provider-applied', kind: 'event_changed', providerEventId: 'bound',
      providerEtag: 'etag-3', title: 'Provider wins', dueAt: '2026-08-21T12:00:00.000Z',
      timeZone: 'Europe/Warsaw',
    });

    expect(missingCheckpoint).toMatchObject({ status: 400, body: { error: 'Invalid calendar inbound command' } });
    expect(missingBinding.body).toMatchObject({ outcome: 'ignored', reason: 'binding_not_found' });
    expect(deleted.body.outcome).toBe('provider_deleted_task_preserved');
    expect((await CalendarBindingModel.findById(binding.id))?.providerDeletedAt).toBeDefined();
    expect(missingTask.body).toMatchObject({ outcome: 'ignored', reason: 'task_not_found' });
    expect(missingTaskBinding).toBeDefined();
    expect(applied.body).toMatchObject({ outcome: 'applied', revision: 1 });
    expect(await TaskModel.findById(task.id)).toMatchObject({ title: 'Provider wins', revision: 1 });
    await expect(new CalendarApplicationService().applyInbound({
      ...base, operationId: 'direct-checkpoint-missing', kind: 'sync_checkpoint',
    })).resolves.toMatchObject({ outcome: 'rejected', reason: 'checkpoint_token_missing' });
  });

  it('validates public sync preconditions and reports pending calendar status', async () => {
    const noKey = await request(app).post('/calendar/sync-requests')
      .set('Authorization', 'Bearer test-api-token').send({});
    const disconnected = await request(app).post('/calendar/sync-requests')
      .set('Authorization', 'Bearer test-api-token').set('Idempotency-Key', 'disconnected').send({});
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    await CalendarSyncStateModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      fullResyncRequired: true,
    });
    await CalendarConflictModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      bindingId: new CalendarBindingModel().id, taskId: new TaskModel().id,
      taskRevision: 1, providerRevision: 'etag', providerSnapshot: {}, status: 'open',
    });
    await CalendarOutboxModel.create({
      eventId: 'pending-status', tenantId: 'local', ownerId: 'local-user',
      aggregateId: connection.id, aggregateRevision: 0, type: 'calendar.sync.requested',
      payload: {}, status: 'pending',
    });
    const status = await api('/calendar/status');

    expect(noKey.status).toBe(428);
    expect(disconnected.status).toBe(409);
    expect(status.body).toMatchObject({ status: 'pending', openConflicts: 1, pendingOutbox: 1 });
  });

  it('lists conflicts and validates every public conflict resolution precondition', async () => {
    const task = await TaskModel.create({ title: 'Local', revision: 2 });
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const binding = await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id, taskId: task.id,
      providerEventId: 'conflict-event', providerEtag: 'old', lastTaskRevision: 1,
      lastProviderRevision: 'old',
    });
    const conflict = await CalendarConflictModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      bindingId: binding.id, taskId: task.id, taskRevision: 2, providerRevision: 'new',
      providerSnapshot: { title: 'Google', dueAt: '2026-08-20T12:00:00.000Z', timeZone: 'Europe/Warsaw' },
      status: 'open', revision: 0,
    });
    const listed = await api('/calendar/conflicts');
    const path = `/calendar/conflicts/${conflict.id}/resolve`;
    const noRevision = await request(app).post(path)
      .set('Authorization', 'Bearer test-api-token').set('Idempotency-Key', 'no-revision').send({ strategy: 'google' });
    const noOperation = await request(app).post(path)
      .set('Authorization', 'Bearer test-api-token').set('If-Match', '"0"').send({ strategy: 'google' });
    const badStrategy = await request(app).post(path)
      .set('Authorization', 'Bearer test-api-token').set('If-Match', '"0"').set('Idempotency-Key', 'bad-strategy').send({ strategy: 'other' });
    const stale = await request(app).post(path)
      .set('Authorization', 'Bearer test-api-token').set('If-Match', '"9"').set('Idempotency-Key', 'stale-revision').send({ strategy: 'google' });
    const missing = await request(app).post(`/calendar/conflicts/${new CalendarConflictModel().id}/resolve`)
      .set('Authorization', 'Bearer test-api-token').set('If-Match', '"0"').set('Idempotency-Key', 'missing-conflict').send({ strategy: 'google' });
    const resolved = await request(app).post(path)
      .set('Authorization', 'Bearer test-api-token').set('If-Match', '"0"').set('Idempotency-Key', 'resolve-google').send({ strategy: 'google' });

    expect(listed.body).toHaveLength(1);
    expect(noRevision.status).toBe(428);
    expect(noOperation.status).toBe(428);
    expect(badStrategy.status).toBe(400);
    expect(stale.status).toBe(412);
    expect(missing.status).toBe(404);
    expect(resolved.status).toBe(200);
    expect(await TaskModel.findById(task.id).lean()).toMatchObject({ title: 'Google', revision: 1 });
    expect(await CalendarBindingModel.findById(binding.id).lean()).toMatchObject({
      lastTaskRevision: 1,
      lastProviderRevision: 'new',
    });
  });

  it('resolves a local conflict by enqueueing an outbound event and rejects unavailable targets', async () => {
    const task = await TaskModel.create({ title: 'Local', revision: 2 });
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const binding = await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id, taskId: task.id,
      providerEventId: 'event', providerEtag: 'old', lastTaskRevision: 1, lastProviderRevision: 'old',
    });
    const conflict = await CalendarConflictModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      bindingId: binding.id, taskId: task.id, taskRevision: 2, providerRevision: 'new',
      providerSnapshot: { title: 'Local snapshot' }, status: 'open', revision: 0,
    });
    const resolved = await request(app).post(`/calendar/conflicts/${conflict.id}/resolve`)
      .set('Authorization', 'Bearer test-api-token').set('If-Match', '"0"').set('Idempotency-Key', 'resolve-local')
      .send({ strategy: 'eisenhower' });
    const unavailable = await CalendarConflictModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      bindingId: new CalendarBindingModel().id, taskId: new TaskModel().id,
      taskRevision: 0, providerRevision: 'missing', providerSnapshot: { title: 'Missing' },
      status: 'open', revision: 0,
    });
    const rejected = await request(app).post(`/calendar/conflicts/${unavailable.id}/resolve`)
      .set('Authorization', 'Bearer test-api-token').set('If-Match', '"0"').set('Idempotency-Key', 'resolve-unavailable')
      .send({ strategy: 'eisenhower' });

    expect(resolved.status).toBe(200);
    expect(await CalendarOutboxModel.findOne({ eventId: `conflict:${conflict.id}:0` })).toMatchObject({
      type: 'event_update', payload: { bindingId: binding.id },
    });
    expect(rejected.status).toBe(409);
  });

  it('replays conflict resolution by Idempotency-Key without repeating side effects', async () => {
    const task = await TaskModel.create({ title: 'Local', revision: 2 });
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const binding = await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id, taskId: task.id,
      providerEventId: 'replay-event', providerEtag: 'old', lastTaskRevision: 1,
      lastProviderRevision: 'old',
    });
    const conflict = await CalendarConflictModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      bindingId: binding.id, taskId: task.id, taskRevision: 2, providerRevision: 'new',
      providerSnapshot: { title: 'Provider' }, status: 'open', revision: 0,
    });
    const invoke = (strategy: 'eisenhower' | 'google') => request(app)
      .post(`/calendar/conflicts/${conflict.id}/resolve`)
      .set('Authorization', 'Bearer test-api-token')
      .set('If-Match', '"0"')
      .set('Idempotency-Key', 'resolve-conflict-replay')
      .send({ strategy });

    const first = await invoke('eisenhower');
    const replay = await invoke('eisenhower');
    const reused = await invoke('google');

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(reused).toMatchObject({ status: 409, body: { error: 'calendar_operation_reused' } });
    expect(await CalendarOutboxModel.countDocuments({ eventId: `conflict:${conflict.id}:0` })).toBe(1);
    expect(await CalendarMutationReceiptModel.countDocuments({ operationId: 'resolve-conflict-replay' })).toBe(1);
  });

  it('fails closed when a conflict transaction produces no resolution result', async () => {
    const session = {
      withTransaction: jest.fn(async () => undefined),
      endSession: jest.fn(async () => undefined),
    };
    jest.spyOn(mongoose, 'startSession').mockResolvedValueOnce(session as never);

    await expect(new CalendarApplicationService().resolveConflict({
      tenantId: 'local', ownerId: 'local-user', actorId: 'local-user',
      operationId: 'incomplete-resolution', conflictId: new CalendarConflictModel().id,
      expectedRevision: 0, strategy: 'google',
    })).rejects.toThrow('calendar_conflict_resolution_incomplete');
    expect(session.endSession).toHaveBeenCalled();
  });

  it('rejects conflicts when exactly one resolution target is unavailable', async () => {
    const task = await TaskModel.create({ title: 'Existing task' });
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const binding = await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id, taskId: task.id,
      providerEventId: 'event', providerEtag: 'old', lastTaskRevision: 0, lastProviderRevision: 'old',
    });
    const conflict = async (bindingId: string, taskId: string) => CalendarConflictModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      bindingId, taskId, taskRevision: 0, providerRevision: 'new',
      providerSnapshot: { title: 'Snapshot' }, status: 'open', revision: 0,
    });
    const missingBinding = await conflict(new CalendarBindingModel().id, task.id);
    const missingTask = await conflict(binding.id, new TaskModel().id);

    for (const item of [missingBinding, missingTask]) {
      const response = await request(app).post(`/calendar/conflicts/${item.id}/resolve`)
        .set('Authorization', 'Bearer test-api-token').set('If-Match', '"0"').set('Idempotency-Key', `resolve-unavailable-${item.id}`)
        .send({ strategy: 'eisenhower' });
      expect(response.status).toBe(409);
    }
  });

  it('uses zero as the resolution revision fallback for legacy records', async () => {
    const task = await TaskModel.create({ title: 'Legacy task' });
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const binding = await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id, taskId: task.id,
      providerEventId: 'legacy-event', providerEtag: 'old', lastTaskRevision: 0,
      lastProviderRevision: 'old',
    });
    const conflict = await CalendarConflictModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      bindingId: binding.id, taskId: task.id, taskRevision: 0, providerRevision: 'new',
      providerSnapshot: { title: 'Legacy snapshot' }, status: 'open', revision: 0,
    });
    await CalendarConflictModel.collection.updateOne({ _id: conflict._id }, { $unset: { revision: '' } });
    await TaskModel.collection.updateOne({ _id: task._id }, { $unset: { revision: '' } });

    const response = await request(app).post(`/calendar/conflicts/${conflict.id}/resolve`)
      .set('Authorization', 'Bearer test-api-token').set('If-Match', '"0"').set('Idempotency-Key', 'resolve-legacy-local')
      .send({ strategy: 'eisenhower' });

    expect(response.status).toBe(200);
    expect(await CalendarOutboxModel.findOne({ eventId: `conflict:${conflict.id}:0` })).toMatchObject({
      aggregateRevision: 0,
    });
  });

  it('increments from the zero fallback for a legacy Google resolution', async () => {
    const task = await TaskModel.create({ title: 'Legacy local' });
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const binding = await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id, taskId: task.id,
      providerEventId: 'legacy-google', providerEtag: 'old', lastTaskRevision: 0,
      lastProviderRevision: 'old',
    });
    const conflict = await CalendarConflictModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      bindingId: binding.id, taskId: task.id, taskRevision: 0, providerRevision: 'new',
      providerSnapshot: {
        title: 'Google legacy', dueAt: '2026-08-20T12:00:00.000Z', timeZone: 'Europe/Warsaw',
      },
      status: 'open', revision: 0,
    });
    await TaskModel.collection.updateOne({ _id: task._id }, { $unset: { revision: '' } });

    const response = await request(app).post(`/calendar/conflicts/${conflict.id}/resolve`)
      .set('Authorization', 'Bearer test-api-token').set('If-Match', '"0"').set('Idempotency-Key', 'resolve-legacy-google')
      .send({ strategy: 'google' });

    expect(response.status).toBe(200);
    expect(await CalendarBindingModel.findById(binding.id).lean()).toMatchObject({ lastTaskRevision: 1 });
  });

  it('applies and conflicts provider changes for legacy tasks without revisions', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const makeLegacy = async (suffix: string, lastTaskRevision: number) => {
      const task = await TaskModel.create({ title: `Legacy ${suffix}` });
      await TaskModel.collection.updateOne({ _id: task._id }, { $unset: { revision: '' } });
      await CalendarBindingModel.create({
        tenantId: 'local', ownerId: 'local-user', connectionId: connection.id, taskId: task.id,
        providerEventId: `legacy-${suffix}`, providerEtag: 'old', lastTaskRevision,
        lastProviderRevision: 'old',
      });
      return task;
    };
    const appliedTask = await makeLegacy('apply', 0);
    const conflictTask = await makeLegacy('conflict', 1);
    const command = (task: typeof appliedTask, suffix: string) => ({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      operationId: `legacy-${suffix}-operation`, kind: 'event_changed',
      providerEventId: `legacy-${suffix}`, providerEtag: 'new', title: 'Provider title',
      dueAt: '2026-08-20T12:00:00.000Z', timeZone: 'Europe/Warsaw', task,
    });

    const appliedBody = command(appliedTask, 'apply');
    const conflictBody = command(conflictTask, 'conflict');
    const { task: _applied, ...appliedCommand } = appliedBody;
    const { task: _conflict, ...conflictCommand } = conflictBody;
    const applied = await internalPost('/internal/calendar/inbound', appliedCommand);
    const conflicted = await internalPost('/internal/calendar/inbound', conflictCommand);

    expect(applied.body).toMatchObject({ outcome: 'applied', revision: 1 });
    expect(conflicted.body).toMatchObject({ outcome: 'conflict' });
  });

  it('supports internal reset and request aliases while validating their bodies', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const base = { tenantId: 'local', ownerId: 'local-user', connectionId: connection.id };
    const invalidReset = await internalPost('/internal/calendar/sync/reset', {});
    const reset = await internalPost('/internal/calendar/sync/reset', {
      ...base, operationId: 'reset-alias',
    });
    const invalidRequest = await internalPost('/internal/calendar/request', {});
    const syncRequest = await internalPost('/internal/calendar/request', {
      ...base, operationId: 'request-alias',
    });
    await CalendarMutationReceiptModel.updateOne(
      { operationId: 'request-alias' }, { $set: { fingerprint: 'wrong' } },
    );
    const reused = await internalPost('/internal/calendar/request', {
      ...base, operationId: 'request-alias',
    });

    expect(invalidReset.status).toBe(400);
    expect(reset.body.outcome).toBe('full_resync_required');
    expect(invalidRequest.status).toBe(400);
    expect(syncRequest.status).toBe(202);
    expect(reused.status).toBe(409);
  });

  it('applies a bounded manual-sync command batch through the signed internal boundary', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const base = { tenantId: 'local', ownerId: 'local-user', connectionId: connection.id };
    const invalid = await internalPost('/internal/calendar/sync/apply-batch', { commands: [] });
    const invalidMember = await internalPost('/internal/calendar/sync/apply-batch', {
      commands: [{ ...base, operationId: 'invalid-member', kind: 'execute_any' }],
    });
    const unknownKind = { ...base, operationId: 'unknown-command', kind: 'execute_any' };
    const malformedChange = {
      ...base, operationId: 'malformed-change', kind: 'event_changed',
      providerEventId: 'event', providerEtag: 'etag', title: 'Bad date',
      dueAt: 'not-a-date', timeZone: 'UTC',
    };
    const applied = await internalPost('/internal/calendar/sync/apply-batch', {
      commands: [{
        ...base, operationId: 'manual-sync-checkpoint', kind: 'sync_checkpoint',
        nextSyncToken: 'manual-sync-token',
      }],
    });

    expect(invalid.status).toBe(400);
    expect(invalidMember.status).toBe(400);
    expect(isCalendarInboundCommand(unknownKind)).toBe(false);
    expect(isCalendarInboundCommand(malformedChange)).toBe(false);
    expect(applied).toMatchObject({
      status: 202, body: { results: [{ outcome: 'sync_completed' }] },
    });
    expect(await CalendarSyncStateModel.findOne({ connectionId: connection.id })).toMatchObject({
      syncToken: 'manual-sync-token', fullResyncRequired: false,
    });
  });

  it('maps batch reuse, unexpected batch failures and non-Error conflict failures', async () => {
    const base = {
      tenantId: 'local', ownerId: 'local-user', connectionId: new CalendarConnectionModel().id,
    };
    const reused = await internalPost('/internal/calendar/sync/apply-batch', {
      commands: [
        { ...base, operationId: 'batch-reuse', kind: 'sync_token_gone' },
        { ...base, operationId: 'batch-reuse', kind: 'sync_checkpoint', nextSyncToken: 'next' },
      ],
    });
    jest.spyOn(CalendarMutationReceiptModel, 'findOne').mockImplementationOnce(() => {
      throw new Error('batch failure');
    });
    const failed = await internalPost('/internal/calendar/sync/apply-batch', {
      commands: [{ ...base, operationId: 'batch-failure', kind: 'sync_token_gone' }],
    });
    jest.spyOn(CalendarApplicationService.prototype, 'resolveConflict').mockRejectedValueOnce('non-error');
    const nonError = await request(app).post(`/calendar/conflicts/${new CalendarConflictModel().id}/resolve`)
      .set('Authorization', 'Bearer test-api-token').set('If-Match', '"0"')
      .set('Idempotency-Key', 'non-error').send({ strategy: 'google' });

    expect(reused).toMatchObject({ status: 409, body: { error: 'calendar_operation_reused' } });
    expect(failed).toMatchObject({ status: 500, body: { error: 'batch failure' } });
    expect(nonError.status).toBe(500);
  });

  it('claims no work and dead-letters dispatches without a connection or required binding', async () => {
    expect((await internalPost('/internal/calendar/outbound/claim', {})).status).toBe(204);
    await CalendarOutboxModel.create({
      eventId: 'no-connection', tenantId: 'local', ownerId: 'local-user',
      aggregateId: new TaskModel().id, aggregateRevision: 1, type: 'event_create',
      payload: {}, status: 'pending',
    });
    const noConnection = await internalPost('/internal/calendar/outbound/claim', {});
    expect(noConnection.status).toBe(409);
    expect(await CalendarOutboxModel.findOne({ eventId: 'no-connection' })).toMatchObject({
      status: 'dead_letter', lastError: 'calendar_connection_missing',
    });

    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    await CalendarOutboxModel.create({
      eventId: 'no-binding', tenantId: 'local', ownerId: 'local-user',
      aggregateId: new TaskModel().id, aggregateRevision: 1, type: 'event_update',
      payload: {}, status: 'pending',
    });
    const noBinding = await internalPost('/internal/calendar/outbox/claim', {});
    expect(noBinding.status).toBe(409);
    expect(connection).toBeDefined();
    expect(await CalendarOutboxModel.findOne({ eventId: 'no-binding' })).toMatchObject({
      status: 'dead_letter', lastError: 'calendar_binding_missing',
    });
  });

  it('acknowledges retry, missing, create, delete and sync outbox results', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const task = await TaskModel.create({ title: 'Ack target' });
    const createEvent = async (eventId: string, type: string) => CalendarOutboxModel.create({
      eventId, tenantId: 'local', ownerId: 'local-user', aggregateId: task.id,
      aggregateRevision: 2, type, payload: {}, status: 'leased', leaseUntil: new Date(),
    });

    await createEvent('retry-event', 'event_create');
    const retry = await internalPost('/internal/calendar/outbound/result', {
      eventId: 'retry-event', delivered: false,
    });
    const missing = await internalPost('/internal/calendar/outbox/acknowledge', {
      eventId: 'missing-event', delivered: true,
    });
    await createEvent('create-event', 'event_create');
    const created = await internalPost('/internal/calendar/outbox/acknowledge', {
      eventId: 'create-event', delivered: true, connectionId: connection.id,
      providerEventId: 'provider-1', providerEtag: 'etag-1',
    });
    await createEvent('delete-event', 'event_delete');
    const deleted = await internalPost('/internal/calendar/outbox/acknowledge', {
      eventId: 'delete-event', delivered: true, providerEtag: 'etag-deleted',
    });
    await createEvent('sync-event', 'calendar.sync.requested');
    const sync = await internalPost('/internal/calendar/outbox/acknowledge', {
      eventId: 'sync-event', delivered: true,
    });

    expect(retry.body).toMatchObject({ status: 'pending', lastError: 'provider_error' });
    expect(missing.status).toBe(404);
    expect(created.body.status).toBe('delivered');
    expect(await CalendarBindingModel.findOne({ taskId: task.id })).toMatchObject({
      providerEventId: 'provider-1', providerEtag: 'etag-deleted',
    });
    expect(deleted.body.status).toBe('delivered');
    expect((await CalendarBindingModel.findOne({ taskId: task.id }))?.providerDeletedAt).toBeDefined();
    expect(sync.body.status).toBe('delivered');
  });

  it('rolls back a delivered acknowledgement when binding persistence fails', async () => {
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const task = await TaskModel.create({ title: 'Atomic acknowledgement' });
    await CalendarOutboxModel.create({
      eventId: 'atomic-ack', tenantId: 'local', ownerId: 'local-user', aggregateId: task.id,
      aggregateRevision: 1, type: 'event_create', payload: {}, status: 'leased',
      leaseId: 'atomic-lease', leaseUntil: new Date(Date.now() + 60_000),
    });
    jest.spyOn(CalendarBindingModel, 'findOneAndUpdate').mockRejectedValueOnce(new Error('binding write failed'));

    const response = await internalPost('/internal/calendar/outbox/acknowledge', {
      eventId: 'atomic-ack', leaseId: 'atomic-lease', delivered: true,
      connectionId: connection.id, providerEventId: 'provider-atomic', providerEtag: 'etag-atomic',
    });

    expect(response.status).toBe(500);
    expect(await CalendarOutboxModel.findOne({ eventId: 'atomic-ack' }).lean()).toMatchObject({
      status: 'leased', leaseId: 'atomic-lease',
    });
    expect(await CalendarBindingModel.countDocuments({ taskId: task.id })).toBe(0);
  });

  it('dead-letters an exhausted acknowledgement and rejects a lease race', async () => {
    const task = await TaskModel.create({ title: 'Lease race' });
    await CalendarOutboxModel.create({
      eventId: 'exhausted-no-error', tenantId: 'local', ownerId: 'local-user',
      aggregateId: task.id, aggregateRevision: 1, type: 'event_create', payload: {},
      status: 'leased', attempts: 5, leaseUntil: new Date(Date.now() + 30_000),
    });
    const exhausted = await internalPost('/internal/calendar/outbox/acknowledge', {
      eventId: 'exhausted-no-error', delivered: false,
    });
    await CalendarOutboxModel.create({
      eventId: 'lease-race', tenantId: 'local', ownerId: 'local-user',
      aggregateId: task.id, aggregateRevision: 1, type: 'event_create', payload: {},
      status: 'leased', attempts: 1, leaseUntil: new Date(Date.now() + 30_000),
    });
    jest.spyOn(CalendarOutboxModel, 'findOneAndUpdate').mockReturnValueOnce({
      lean: async () => null,
    } as never);
    const raced = await internalPost('/internal/calendar/outbox/acknowledge', {
      eventId: 'lease-race', delivered: true,
    });

    expect(exhausted.body).toMatchObject({ status: 'dead_letter', lastError: 'provider_error' });
    expect(raced).toMatchObject({ status: 409, body: { error: 'Outbox event lease changed' } });
  });

  it('rejects unknown notifications and covers page checkpoints with unknown message numbers', async () => {
    const invalid = await internalPost('/internal/calendar/notifications/validate', {
      channelId: 'missing', resourceId: 'missing',
    });
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'revoked',
    });
    await CalendarSyncStateModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      pageToken: 'page-current', fullResyncRequired: false,
      watch: { channelId: 'channel-page', resourceId: 'resource-page', verificationHash: createHash('sha256').update('page-secret').digest('hex'), expiresAt: new Date(Date.now() + 60_000) },
    });
    const revoked = await internalPost('/internal/calendar/notifications/validate', {
      channelId: 'channel-page', resourceId: 'resource-page', channelToken: 'page-secret', messageNumber: '1',
    });
    await CalendarConnectionModel.updateOne({ _id: connection.id }, { $set: { status: 'active' } });
    const valid = await internalPost('/internal/calendar/notifications/validate', {
      channelId: 'channel-page', resourceId: 'resource-page', channelToken: 'page-secret', messageNumber: '1',
    });

    expect(invalid).toMatchObject({ status: 403, body: { valid: false } });
    expect(revoked).toMatchObject({ status: 403, body: { valid: false } });
    expect(valid.body).toMatchObject({ pageToken: 'page-current', signalId: 'channel-page:1' });
  });

  it.each([
    [{ channelId: 'channel' }],
    [{ channelId: 'channel', resourceId: 'resource' }],
    [{ channelId: 'channel', resourceId: 'resource', channelToken: 'token' }],
    [{ channelId: 'channel', resourceId: 'resource', channelToken: 'token', messageNumber: 'nope' }],
    [{ channelId: 'channel', resourceId: 'resource', channelToken: 'token', messageNumber: '9007199254740992' }],
    [{ channelId: 'channel', resourceId: 'resource', channelToken: 'token', messageNumber: '0' }],
  ])('rejects malformed notification field combinations %#', async (body) => {
    expect(await internalPost('/internal/calendar/notifications/validate', body)).toMatchObject({
      status: 403, body: { valid: false },
    });
  });

  it('validates and persists watch renewal and internal status responses', async () => {
    const invalidWatch = await internalPost('/internal/calendar/watch/renew', {});
    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const watch = await internalPost('/internal/calendar/watch/renew', {
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      channelId: 'renewed', resourceId: 'resource', verificationHash: 'a'.repeat(64),
      expiresAt: '2026-08-30T12:00:00.000Z',
    });
    const missing = await internalPost('/internal/calendar/status', {
      tenantId: 'local', ownerId: 'local-user', connectionId: new CalendarConnectionModel().id,
    });
    const status = await internalPost('/internal/calendar/status', {
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
    });

    expect(invalidWatch.status).toBe(400);
    expect(watch.body.watch.channelId).toBe('renewed');
    expect(missing.status).toBe(404);
    expect(status.body).toMatchObject({ openConflicts: 0, pendingOutbox: 0 });
    expect(status.body.connection.credentialRef).toBe('reference');
  });

  it('maps calendar route failures through the application error boundary', async () => {
    jest.spyOn(CalendarConnectionModel, 'findOne').mockImplementationOnce(() => {
      throw new Error('status failure');
    });
    const status = await api('/calendar/status');
    jest.spyOn(CalendarConnectionModel, 'findOne').mockImplementationOnce(() => {
      throw new Error('sync failure');
    });
    const sync = await request(app).post('/calendar/sync-requests')
      .set('Authorization', 'Bearer test-api-token').set('Idempotency-Key', 'error').send({});
    jest.spyOn(CalendarConflictModel, 'find').mockImplementationOnce(() => {
      throw new Error('list failure');
    });
    const conflicts = await api('/calendar/conflicts');
    jest.spyOn(CalendarConflictModel, 'findOne').mockImplementationOnce(() => {
      throw new Error('resolve failure');
    });
    const resolved = await request(app).post(`/calendar/conflicts/${new CalendarConflictModel().id}/resolve`)
      .set('Authorization', 'Bearer test-api-token').set('If-Match', '"0"').set('Idempotency-Key', 'resolve-error')
      .send({ strategy: 'google' });

    expect(status).toMatchObject({ status: 500, body: { error: 'status failure' } });
    expect(sync).toMatchObject({ status: 500, body: { error: 'sync failure' } });
    expect(conflicts).toMatchObject({ status: 500, body: { error: 'list failure' } });
    expect(resolved).toMatchObject({ status: 500, body: { error: 'resolve failure' } });
  });

  it('covers every required internal command field and missing HMAC headers', async () => {
    const noHeaders = await request(app).post('/internal/calendar/inbound').send({});
    expect(noHeaders.status).toBe(401);

    const inbound = {
      operationId: 'all-fields', tenantId: 'local', ownerId: 'local-user',
      connectionId: new CalendarConnectionModel().id, kind: 'sync_token_gone',
    };
    for (const field of Object.keys(inbound)) {
      const body = { ...inbound, [field]: '' };
      expect((await internalPost('/internal/calendar/inbound', body)).status).toBe(400);
    }
    for (const path of ['/internal/calendar/sync/reset', '/internal/calendar/request']) {
      for (const field of ['operationId', 'tenantId', 'ownerId', 'connectionId']) {
        const body = { ...inbound, [field]: 0 };
        expect((await internalPost(path, body)).status).toBe(400);
      }
    }
    const watch = {
      tenantId: 'local', ownerId: 'local-user', connectionId: new CalendarConnectionModel().id,
      channelId: 'channel', resourceId: 'resource', verificationHash: 'a'.repeat(64),
      expiresAt: '2026-09-01T00:00:00.000Z',
    };
    for (const field of Object.keys(watch)) {
      const body = { ...watch, [field]: '' };
      expect((await internalPost('/internal/calendar/watch/renew', body)).status).toBe(400);
    }
  });

  it('forwards unexpected errors from every internal handler to the app boundary', async () => {
    const inbound = {
      operationId: 'unexpected-error', tenantId: 'local', ownerId: 'local-user',
      connectionId: new CalendarConnectionModel().id, kind: 'sync_token_gone',
    };

    jest.spyOn(CalendarMutationReceiptModel, 'findOne').mockImplementationOnce(() => {
      throw new Error('inbound failure');
    });
    const inboundFailure = await internalPost('/internal/calendar/inbound', inbound);
    jest.spyOn(CalendarMutationReceiptModel, 'findOne').mockImplementationOnce(() => {
      throw new Error('reset failure');
    });
    const resetFailure = await internalPost('/internal/calendar/sync/reset', inbound);
    jest.spyOn(CalendarMutationReceiptModel, 'findOne').mockImplementationOnce(() => {
      throw new Error('request failure');
    });
    const requestFailure = await internalPost('/internal/calendar/request', inbound);
    jest.spyOn(CalendarOutboxModel, 'findOneAndUpdate').mockImplementationOnce(() => {
      throw new Error('claim failure');
    });
    const claimFailure = await internalPost('/internal/calendar/outbound/claim', {});
    jest.spyOn(CalendarOutboxModel, 'findOne').mockImplementationOnce(() => {
      throw new Error('ack failure');
    });
    const ackFailure = await internalPost('/internal/calendar/outbound/result', {
      eventId: 'ack-failure', delivered: true,
    });
    jest.spyOn(CalendarSyncStateModel, 'findOne').mockImplementationOnce(() => {
      throw new Error('notification failure');
    });
    const notificationFailure = await internalPost('/internal/calendar/notifications/validate', {
      channelId: 'channel', resourceId: 'resource', channelToken: 'secret', messageNumber: '1',
    });
    jest.spyOn(CalendarSyncStateModel, 'findOneAndUpdate').mockImplementationOnce(() => {
      throw new Error('watch failure');
    });
    const watchFailure = await internalPost('/internal/calendar/watch/renew', {
      tenantId: 'local', ownerId: 'local-user', connectionId: new CalendarConnectionModel().id,
      channelId: 'channel', resourceId: 'resource', verificationHash: 'a'.repeat(64),
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
    jest.spyOn(CalendarConnectionModel, 'find').mockImplementationOnce(() => {
      throw new Error('reconciliation failure');
    });
    const reconciliationFailure = await internalPost('/internal/calendar/reconciliation/claim', {});
    jest.spyOn(CalendarConnectionModel, 'findOne').mockImplementationOnce(() => {
      throw new Error('internal status failure');
    });
    const statusFailure = await internalPost('/internal/calendar/status', {});

    expect(inboundFailure.body.error).toBe('inbound failure');
    expect(resetFailure.body.error).toBe('reset failure');
    expect(requestFailure.body.error).toBe('request failure');
    expect(claimFailure.body.error).toBe('claim failure');
    expect(ackFailure.body.error).toBe('ack failure');
    expect(notificationFailure.body.error).toBe('notification failure');
    expect(watchFailure.body.error).toBe('watch failure');
    expect(reconciliationFailure.body.error).toBe('reconciliation failure');
    expect(statusFailure.body.error).toBe('internal status failure');
  });

  it('covers optional internal payload, dispatch, acknowledgement, and reconciliation variants', async () => {
    const emptyBody = await internalPost('/internal/calendar/notifications/validate', undefined);
    expect(emptyBody.status).toBe(403);
    expect((await internalPost('/internal/calendar/sync/reset', undefined)).status).toBe(400);
    expect((await internalPost('/internal/calendar/request', undefined)).status).toBe(400);
    expect((await internalPost('/internal/calendar/watch/renew', undefined)).status).toBe(400);
    expect((await internalPost('/internal/calendar/status', undefined)).status).toBe(404);

    const connection = await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
      credentialRef: 'reference', status: 'active',
    });
    const task = await TaskModel.create({ title: 'Variants' });
    await CalendarBindingModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id, taskId: task.id,
      providerEventId: 'bound', providerEtag: 'etag', lastTaskRevision: 0,
      lastProviderRevision: 'etag',
    });
    await CalendarOutboxModel.create({
      eventId: 'claim-with-binding', tenantId: 'local', ownerId: 'local-user', aggregateId: task.id,
      aggregateRevision: 1, type: 'event_update', payload: {}, status: 'pending',
    });
    const claimed = await internalPost('/internal/calendar/outbound/claim', {});
    expect(claimed.body.provider).toMatchObject({ providerEventId: 'bound', providerEtag: 'etag' });

    await CalendarOutboxModel.create({
      eventId: 'claim-without-binding', tenantId: 'local', ownerId: 'local-user',
      aggregateId: new TaskModel().id, aggregateRevision: 1, type: 'event_create',
      payload: {}, status: 'pending',
    });
    const unboundClaim = await internalPost('/internal/calendar/outbound/claim', {});
    expect(unboundClaim.body.provider).toEqual({
      connectionId: connection.id, calendarId: 'primary',
    });
    expect((await internalPost('/internal/calendar/outbound/result', undefined)).status).toBe(400);

    await CalendarOutboxModel.create({
      eventId: 'delete-no-etag', tenantId: 'local', ownerId: 'local-user', aggregateId: task.id,
      aggregateRevision: 2, type: 'event_delete', payload: {}, status: 'leased',
    });
    expect((await internalPost('/internal/calendar/outbound/result', {
      eventId: 'delete-no-etag', delivered: true,
    })).status).toBe(200);

    await CalendarOutboxModel.create({
      eventId: 'update-missing-provider-data', tenantId: 'local', ownerId: 'local-user',
      aggregateId: task.id, aggregateRevision: 3, type: 'event_update', payload: {}, status: 'leased',
    });
    expect((await internalPost('/internal/calendar/outbound/result', {
      eventId: 'update-missing-provider-data', delivered: true,
    })).status).toBe(200);

    await CalendarConnectionModel.create({
      tenantId: 'local', ownerId: 'no-state', provider: 'google', calendarId: 'secondary',
      credentialRef: 'reference', status: 'active',
    });
    await CalendarSyncStateModel.create({
      tenantId: 'local', ownerId: 'local-user', connectionId: connection.id,
      pageToken: 'reconcile-page', fullResyncRequired: false,
    });
    const jobs = await internalPost('/internal/calendar/reconciliation/claim', {});
    expect(jobs.body.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: 'no-state', fullResyncRequired: true }),
    ]));
    expect(jobs.body.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: 'local-user', pageToken: 'reconcile-page' }),
    ]));
  });

});
