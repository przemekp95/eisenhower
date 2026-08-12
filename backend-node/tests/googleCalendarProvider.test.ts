import request from 'supertest';
import { createApp } from '../src/app';
import { GoogleCalendarHttpAdapter, GoogleCalendarPort } from '../src/application/googleCalendar';
import { GoogleOAuthPort, GoogleTokenSet } from '../src/application/googleOAuth';
import { CalendarConnectionModel, CalendarOutboxModel, CalendarSyncStateModel, GoogleOAuthGrantModel } from '../src/models/calendar';
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
  async listChanges(input: Record<string, unknown>) { this.calls.push({ kind: 'changes', ...input }); return { events: [{ id: 'historical-event' }], nextSyncToken: 'sync-next' }; }
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

  it('maps Google 410 changes to a controlled reset result', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 410 }));
    const result = await new GoogleCalendarHttpAdapter().listChanges({
      accessToken: 'token', calendarId: 'primary', syncToken: 'expired-sync',
    });
    expect(result).toEqual({ events: [], resetRequired: true });
  });
});
