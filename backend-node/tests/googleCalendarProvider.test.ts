import request from 'supertest';
import { createApp } from '../src/app';
import {
  GoogleCalendarHttpAdapter, GoogleCalendarPort, GoogleCalendarService, loadGoogleCalendarConfig,
} from '../src/application/googleCalendar';
import { GoogleOAuthPort, GoogleTokenSet } from '../src/application/googleOAuth';
import { CalendarBindingModel, CalendarConnectionModel, CalendarOutboxModel, CalendarSyncStateModel, GoogleOAuthGrantModel } from '../src/models/calendar';
import mongoose from 'mongoose';
import { clearMongo, startMongo, stopMongo } from './helpers/mongo';
import { createHmac } from 'node:crypto';

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
}
const hmacKey = 'provider-internal-key-at-least-32-bytes';
function signed(path: string, body: unknown) { const timestamp = String(Math.floor(Date.now() / 1000)); const raw = JSON.stringify(body); return { timestamp, signature: createHmac('sha256', hmacKey).update(`v1\n${timestamp}\nPOST\n${path}\n${raw}`).digest('hex') }; }

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

  async function connect() { const start = await request(app).post('/calendar/oauth/start').set('Authorization', 'Bearer test-api-token').send({ returnPath: '/' }); const state = new URL(start.body.authorizationUrl).searchParams.get('state')!; await request(app).get('/calendar/oauth/callback').query({ state, code: 'code' }); return CalendarConnectionModel.findOne(); }
  async function post(path: string, body: Record<string, unknown>) { const auth = signed(path, body); return request(app).post(path).set('X-Eisenhower-Timestamp', auth.timestamp).set('X-Eisenhower-Signature', auth.signature).send(body); }

  it('resolves an outbox event through its own OAuth grant and returns no tokens', async () => {
    const connection = await connect();
    await CalendarOutboxModel.create({ eventId: 'out-1', tenantId: 'local', ownerId: 'local-user', aggregateId: 'task-1', aggregateRevision: 1, type: 'event_create', payload: { title: 'Task' }, status: 'pending' });
    const response = await post('/internal/calendar/provider/outbound', { eventId: 'out-1' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ providerEventId: expect.any(String), providerEtag: 'etag-created', connectionId: connection!.id });
    expect(JSON.stringify(response.body)).not.toContain('secret');
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
    await connect();
    const before = await GoogleOAuthGrantModel.findOne().select('+tokenCiphertext').lean();
    await CalendarOutboxModel.create({ eventId: 'refresh-event', tenantId: 'local', ownerId: 'local-user', aggregateId: 'task-refresh', aggregateRevision: 1, type: 'event_create', payload: { title: 'Task' }, status: 'pending' });
    const response = await post('/internal/calendar/provider/outbound', { eventId: 'refresh-event' });
    const after = await GoogleOAuthGrantModel.findOne().select('+tokenCiphertext').lean();
    expect(response.status).toBe(200);
    expect(calendar.calls.filter((call) => call.kind === 'refresh')).toHaveLength(1);
    expect(after?.tokenCiphertext).not.toBe(before?.tokenCiphertext);
    expect(JSON.stringify(response.body)).not.toContain('rotated-access');
  });

  it('allows only configured HTTPS watch callbacks and never returns channel token', async () => {
    const connection = await connect();
    const allowed = await post('/internal/calendar/provider/watch', { connectionId: connection!.id, address: 'https://hooks.example.com/google-calendar' });
    const denied = await post('/internal/calendar/provider/watch', { connectionId: connection!.id, address: 'https://evil.example/hook' });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ channelId: expect.any(String), resourceId: 'resource-1', expiresAt: expect.any(String) });
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
      const signature = createHmac('sha256', hmacKey)
        .update(`v1\n${timestamp}\nPOST\n${path}\n`)
        .digest('hex');
      return request(app).post(path)
        .set('X-Eisenhower-Timestamp', timestamp)
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
    calendar.listChanges = async (input) => ({ events: [{ id: 'historical' }], ...(input.pageToken ? { nextSyncToken: 'done' } : { nextPageToken: 'page-2' }) });
    expect((await post('/internal/calendar/provider/changes', { connectionId: connection!.id, checkpoint: 'full-resync' })).body)
      .toEqual({ events: [], nextPageToken: 'page-2' });
    await CalendarSyncStateModel.create({ tenantId: 'local', ownerId: 'local-user', connectionId: connection!.id, pageToken: 'page-2', fullResyncRequired: false });
    expect((await post('/internal/calendar/provider/changes', { connectionId: connection!.id, checkpoint: 'page-2' })).body)
      .toEqual({ events: [{ id: 'historical' }], nextSyncToken: 'done' });
  });
});
