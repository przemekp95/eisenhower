import { createHmac, randomUUID } from 'node:crypto';
import type { GoogleCalendarPort } from '../../src/application/googleCalendar';
import type { GoogleOAuthPort, GoogleTokenSet } from '../../src/application/googleOAuth';
import { createApp as createNestApp } from '../../src/app';
import { CalendarConnectionModel, GoogleOAuthGrantModel } from '../../src/models/calendar';
import { clearMongo, startMongo, stopMongo } from '../helpers/mongo';

class OAuthFake implements GoogleOAuthPort {
  revoked: string[] = [];

  authorizationUrl(input: { state: string; codeChallenge: string }) {
    return `https://accounts.google.test/auth?state=${input.state}&code_challenge=${input.codeChallenge}`;
  }

  async exchangeCode(): Promise<GoogleTokenSet> {
    return {
      accessToken: 'access-secret', refreshToken: 'refresh-secret',
      expiresAt: new Date(Date.now() + 3_600_000), googleSubject: 'google-user',
      scopes: ['openid', 'https://www.googleapis.com/auth/calendar.events'],
    };
  }

  async revoke(token: string) { this.revoked.push(token); }
}

class CalendarFake implements GoogleCalendarPort {
  calls: Array<Record<string, unknown>> = [];

  async refresh(tokens: GoogleTokenSet) { return tokens; }

  async createEvent(input: Record<string, unknown>) {
    this.calls.push({ kind: 'create', ...input });
    return { providerEventId: 'provider-1', providerEtag: 'etag-created' };
  }

  async updateEvent(input: Record<string, unknown>) {
    this.calls.push({ kind: 'update', ...input });
    return { providerEventId: 'provider-1', providerEtag: 'etag-updated' };
  }

  async deleteEvent(input: Record<string, unknown>) {
    this.calls.push({ kind: 'delete', ...input });
    return { providerEventId: 'provider-1', providerEtag: 'etag-deleted' };
  }
  async getEvent(input: Record<string, unknown>) {
    this.calls.push({ kind: 'get', ...input });
    return {
      id: 'provider-1', etag: 'etag-1', title: 'Task',
      start: '2026-08-23T10:00:00.000Z', end: '2026-08-23T11:00:00.000Z', timeZone: 'UTC',
    };
  }

  async listChanges(input: Record<string, unknown>) {
    this.calls.push({ kind: 'list', ...input });
    return { events: [], nextSyncToken: 'sync-next' };
  }

  async listEvents(input: Record<string, unknown>) {
    this.calls.push({ kind: 'events', ...input });
    return { events: [] };
  }

  async watch(input: Record<string, unknown>) {
    this.calls.push({ kind: 'watch', ...input });
    return { channelId: String(input.channelId), resourceId: 'resource-1', expiresAt: new Date(Date.now() + 3_600_000) };
  }
}

describe('Nest Fastify Google integration', () => {
  const originalEnvironment = { ...process.env };
  const hmacKey = 'nest-google-provider-hmac-key-32-bytes-minimum';
  const oauth = new OAuthFake();
  const calendar = new CalendarFake();
  let app: Awaited<ReturnType<typeof createNestApp>>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER = 'https://identity.example.com';
    process.env.OIDC_AUDIENCE = 'eisenhower-api';
    process.env.OIDC_JWKS_URL = 'https://identity.example.com/.well-known/jwks.json';
    await startMongo();
    app = await createNestApp({
      auditSink: { record: () => undefined },
      oidcTokenVerifier: async () => ({
        tenantId: 'tenant-a', userId: 'owner-a', roles: [], projectIds: [], scopes: ['calendar:write'],
      }),
      calendarInternalHmacKey: hmacKey,
      googleOAuthPort: oauth,
      googleCalendarPort: calendar,
      googleOAuthConfig: {
        clientId: 'client', clientSecret: 'secret',
        callbackUrl: 'https://api.example.com/calendar/oauth/callback',
        encryptionKeys: { current: Buffer.alloc(32, 7) }, currentKeyVersion: 'current',
        returnOrigins: ['https://tasks.example.com'],
      },
      googleCalendarConfig: { watchCallbackUrls: ['https://api.example.com/calendar/notifications'] },
    });
  });

  afterEach(async () => {
    oauth.revoked = [];
    calendar.calls = [];
    await clearMongo();
  });
  afterAll(async () => {
    await app.close();
    await stopMongo();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
  });

  it('starts OAuth, consumes state once and redirects with the exact status/location', async () => {
    const start = await app.inject({
      method: 'POST', url: '/calendar/oauth/start',
      headers: { authorization: 'Bearer token' }, payload: { returnPath: '/settings?tab=calendar' },
    });
    const state = new URL(start.json().authorizationUrl).searchParams.get('state')!;
    const callback = await app.inject({
      method: 'GET', url: `/calendar/oauth/callback?state=${state}&code=google-code`,
    });
    const replay = await app.inject({
      method: 'GET', url: `/calendar/oauth/callback?state=${state}&code=google-code`,
    });

    expect(start.statusCode).toBe(201);
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe('https://tasks.example.com/settings?tab=calendar&calendar=connected');
    expect(replay.statusCode).toBe(400);
    expect(await GoogleOAuthGrantModel.findOne()).toMatchObject({ status: 'active' });
    expect(await CalendarConnectionModel.findOne()).toMatchObject({ status: 'active' });
  });

  it('preserves OAuth validation, scope and disconnect behavior', async () => {
    const missing = await app.inject({ method: 'GET', url: '/calendar/oauth/callback' });
    const denied = await app.inject({ method: 'GET', url: '/calendar/oauth/callback?error=denied' });
    const unsafe = await app.inject({
      method: 'POST', url: '/calendar/oauth/start', headers: { authorization: 'Bearer token' },
      payload: { returnPath: 'https://evil.example/steal' },
    });
    const disconnected = await app.inject({
      method: 'POST', url: '/calendar/oauth/disconnect', headers: { authorization: 'Bearer token' },
    });

    expect(missing.json()).toEqual({ error: 'OAuth state and code are required' });
    expect(denied.json()).toEqual({ error: 'Google authorization was not completed' });
    expect(unsafe.json()).toEqual({ error: 'Unsafe OAuth return path' });
    expect(disconnected.statusCode).toBe(204);
  });

  it('requires a valid internal signature before provider validation', async () => {
    const path = '/internal/calendar/provider/outbound';
    const unsigned = await app.inject({ method: 'POST', url: path, payload: {} });
    const signed = await signedPost(path, {});

    expect(unsigned.statusCode).toBe(401);
    expect(signed.statusCode).toBe(400);
    expect(signed.json()).toEqual({ error: 'eventId is required' });
  });

  it('delegates signed provider changes/watch and sanitizes unavailable state', async () => {
    const start = await app.inject({
      method: 'POST', url: '/calendar/oauth/start',
      headers: { authorization: 'Bearer token' }, payload: { returnPath: '/' },
    });
    const state = new URL(start.json().authorizationUrl).searchParams.get('state')!;
    await app.inject({ method: 'GET', url: `/calendar/oauth/callback?state=${state}&code=code` });
    const connection = await CalendarConnectionModel.findOne();
    const changes = await signedPost('/internal/calendar/provider/changes', {
      connectionId: connection!.id, checkpoint: 'full-resync',
    });
    const watch = await signedPost('/internal/calendar/provider/watch', {
      connectionId: connection!.id, address: 'https://api.example.com/calendar/notifications',
    });
    const mismatch = await signedPost('/internal/calendar/provider/changes', {
      connectionId: connection!.id, checkpoint: 'wrong',
    });

    expect(changes.json()).toEqual({ events: [], nextSyncToken: 'sync-next' });
    expect(watch.json()).toMatchObject({ resourceId: 'resource-1', verificationHash: expect.any(String) });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toEqual({ error: 'Provider state is unavailable' });
    expect(JSON.stringify([changes.json(), watch.json(), mismatch.json()])).not.toContain('secret');
  });

  async function signedPost(path: string, payload: Record<string, unknown>) {
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const requestId = randomUUID();
    const signature = createHmac('sha256', hmacKey)
      .update(`v1\n${timestamp}\n${requestId}\nPOST\n${path}\n${raw}`)
      .digest('hex');
    return app.inject({
      method: 'POST', url: path, payload: raw,
      headers: {
        'content-type': 'application/json', 'x-eisenhower-timestamp': timestamp,
        'x-eisenhower-request-id': requestId, 'x-eisenhower-signature': signature,
      },
    });
  }
});
