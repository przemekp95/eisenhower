import request from 'supertest';
import { createApp } from '../src/app';
import {
  GoogleOAuthHttpClient, GoogleOAuthPort, GoogleOAuthService, GoogleTokenSet,
  loadGoogleOAuthConfig,
} from '../src/application/googleOAuth';
import { CalendarConnectionModel, GoogleOAuthAttemptModel, GoogleOAuthGrantModel } from '../src/models/calendar';
import { clearMongo, startMongo, stopMongo } from './helpers/mongo';
import { TaskModel } from '../src/models/task';

class FakeGoogleOAuth implements GoogleOAuthPort {
  revoked: string[] = [];
  scopes = ['openid', 'https://www.googleapis.com/auth/calendar.events'];
  omitRefresh = false;
  authorizationUrl(input: { state: string; codeChallenge: string; callbackUrl: string; clientId: string }) {
    return `https://accounts.google.test/auth?state=${input.state}&code_challenge=${input.codeChallenge}`;
  }
  async exchangeCode(): Promise<GoogleTokenSet> {
    return {
      accessToken: 'access-secret', ...(this.omitRefresh ? {} : { refreshToken: 'refresh-secret' }), expiresAt: new Date(Date.now() + 3600_000),
      googleSubject: 'google-user-123', scopes: this.scopes,
    };
  }
  async revoke(token: string) { this.revoked.push(token); }
}

describe('per-user Google Calendar OAuth', () => {
  const google = new FakeGoogleOAuth();
  const app = createApp({
    aiHealthChecker: async () => 'healthy', databaseStatusResolver: () => 'connected',
    googleOAuthPort: google,
    googleOAuthConfig: {
      clientId: 'google-client-id', clientSecret: 'google-client-secret',
      callbackUrl: 'https://app.example.com/calendar/oauth/callback',
      encryptionKeys: { current: Buffer.alloc(32, 7) }, currentKeyVersion: 'current',
      returnOrigins: ['https://app.example.com'],
    },
  });
  const bearer = 'Bearer test-api-token';

  beforeAll(startMongo);
  afterEach(async () => { google.revoked = []; google.scopes = ['openid', 'https://www.googleapis.com/auth/calendar.events']; google.omitRefresh = false; await clearMongo(); });
  afterAll(stopMongo);

  it('starts with scoped identity and stores only hashed state plus encrypted PKCE verifier', async () => {
    const response = await request(app).post('/calendar/oauth/start')
      .set('Authorization', bearer).send({ returnPath: '/settings/calendar' });

    expect(response.status).toBe(201);
    expect(response.body.authorizationUrl).toContain('https://accounts.google.test/auth');
    expect(response.body).not.toHaveProperty('state');
    const attempt = await GoogleOAuthAttemptModel.findOne().select('+pkceCiphertext +pkceIv +pkceTag').lean();
    expect(attempt?.stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(attempt?.pkceCiphertext).not.toContain('verifier');
    expect(attempt?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('consumes state once, creates encrypted token grant and secret-free connection', async () => {
    const start = await request(app).post('/calendar/oauth/start')
      .set('Authorization', bearer).send({ returnPath: '/settings/calendar' });
    const state = new URL(start.body.authorizationUrl).searchParams.get('state')!;
    const callback = await request(app).get('/calendar/oauth/callback').query({ state, code: 'google-code' });
    const replay = await request(app).get('/calendar/oauth/callback').query({ state, code: 'google-code' });

    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe('https://app.example.com/settings/calendar?calendar=connected');
    expect(replay.status).toBe(400);
    const grant = await GoogleOAuthGrantModel.findOne().select('+tokenCiphertext +tokenIv +tokenTag').lean();
    expect(grant).toMatchObject({ googleSubject: 'google-user-123', status: 'active', keyVersion: 'current' });
    expect(JSON.stringify(grant)).not.toContain('access-secret');
    const connection = await CalendarConnectionModel.findOne().lean();
    expect(connection?.credentialRef).toBe(`oauth-grant:${String(grant?._id)}`);
  });

  it('rejects unsafe return paths and disconnects without deleting tasks', async () => {
    const unsafe = await request(app).post('/calendar/oauth/start')
      .set('Authorization', bearer).send({ returnPath: 'https://evil.example/steal' });
    expect(unsafe.status).toBe(400);

    const start = await request(app).post('/calendar/oauth/start')
      .set('Authorization', bearer).send({ returnPath: '/' });
    const state = new URL(start.body.authorizationUrl).searchParams.get('state')!;
    await request(app).get('/calendar/oauth/callback').query({ state, code: 'code' });
    const task = await TaskModel.create({ tenantId: 'local', ownerId: 'local-user', title: 'Preserve me' });
    const disconnected = await request(app).post('/calendar/oauth/disconnect')
      .set('Authorization', bearer).send({});

    expect(disconnected.status).toBe(204);
    expect(await GoogleOAuthGrantModel.findOne()).toMatchObject({ status: 'revoked' });
    expect(await CalendarConnectionModel.findOne()).toMatchObject({ status: 'revoked' });
    expect(google.revoked).toEqual(['refresh-secret']);
    expect(await TaskModel.findById(task.id)).not.toBeNull();
  });

  it('loads OAuth configuration fail-closed', () => {
    expect(loadGoogleOAuthConfig({}, 'production')).toBeNull();
    expect(() => loadGoogleOAuthConfig({ GOOGLE_CALENDAR_OAUTH_CLIENT_ID: 'partial' }, 'production'))
      .toThrow('required together');
    const base = {
      GOOGLE_CALENDAR_OAUTH_CLIENT_ID: 'client', GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: 'secret',
      GOOGLE_CALENDAR_OAUTH_CALLBACK_URL: 'http://app.example.com/callback',
      GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    };
    expect(() => loadGoogleOAuthConfig(base, 'production')).toThrow('must use HTTPS');
    expect(() => loadGoogleOAuthConfig({
      ...base, GOOGLE_CALENDAR_OAUTH_CALLBACK_URL: 'https://app.example.com/callback',
      GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY: 'short',
    }, 'production')).toThrow('exactly 32 bytes');
    expect(loadGoogleOAuthConfig({
      ...base, GOOGLE_CALENDAR_OAUTH_CALLBACK_URL: 'http://localhost/callback',
      GOOGLE_CALENDAR_OAUTH_RETURN_ORIGIN: 'http://localhost',
    }, 'development')).toMatchObject({ callbackUrl: 'http://localhost/callback' });
  });

  it('validates injected service configuration', () => {
    const valid = {
      clientId: 'id', clientSecret: 'secret', callbackUrl: 'https://app.example/callback',
      encryptionKeys: { v1: Buffer.alloc(32) }, currentKeyVersion: 'v1', returnOrigins: ['https://app.example'],
    };
    expect(() => new GoogleOAuthService({ ...valid, clientId: '' }, google)).toThrow('incomplete');
    expect(() => new GoogleOAuthService({ ...valid, callbackUrl: 'http://app.example/callback' }, google)).toThrow('HTTPS');
    expect(() => new GoogleOAuthService({ ...valid, returnOrigins: [] }, google)).toThrow('exact origins');
    expect(() => new GoogleOAuthService({ ...valid, returnOrigins: ['https://app.example/path'] }, google)).toThrow('exact origins');
    expect(() => new GoogleOAuthService({ ...valid, encryptionKeys: { v1: Buffer.alloc(2) } }, google)).toThrow('32 bytes');
  });

  it('covers the real OAuth HTTP client success and failure contracts', async () => {
    const client = new GoogleOAuthHttpClient();
    const url = new URL(client.authorizationUrl({ state: 'state', codeChallenge: 'challenge', callbackUrl: 'https://app.example/cb', clientId: 'client' }));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const fetchSpy = jest.spyOn(global, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 10, scope: 'openid calendar' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'subject' }), { status: 200 }));
    await expect(client.exchangeCode({ code: 'code', codeVerifier: 'verifier', callbackUrl: 'https://app.example/cb', clientId: 'client', clientSecret: 'secret' }))
      .resolves.toMatchObject({ accessToken: 'access', googleSubject: 'subject', scopes: ['openid', 'calendar'] });
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 400 }));
    await expect(client.exchangeCode({ code: 'x', codeVerifier: 'v', callbackUrl: 'https://a/cb', clientId: 'i', clientSecret: 's' })).rejects.toThrow('exchange_failed');
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'a' }), { status: 200 }));
    await expect(client.exchangeCode({ code: 'x', codeVerifier: 'v', callbackUrl: 'https://a/cb', clientId: 'i', clientSecret: 's' })).rejects.toThrow('incomplete');
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(client.exchangeCode({ code: 'x', codeVerifier: 'v', callbackUrl: 'https://a/cb', clientId: 'i', clientSecret: 's' })).rejects.toThrow('subject_failed');
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await expect(client.exchangeCode({ code: 'x', codeVerifier: 'v', callbackUrl: 'https://a/cb', clientId: 'i', clientSecret: 's' })).rejects.toThrow('subject_missing');
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));
    await expect(client.revoke('token')).resolves.toBeUndefined();
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'subject' }), { status: 200 }));
    await expect(client.exchangeCode({ code: 'code', codeVerifier: 'verifier', callbackUrl: 'https://app.example/cb', clientId: 'client', clientSecret: 'secret' }))
      .resolves.toMatchObject({ scopes: [] });
  });

  it('handles missing grant and best-effort provider revoke failure', async () => {
    expect((await request(app).post('/calendar/oauth/disconnect').set('Authorization', bearer)).status).toBe(204);
    const start = await request(app).post('/calendar/oauth/start').set('Authorization', bearer).send({ returnPath: '/' });
    await request(app).get('/calendar/oauth/callback').query({ state: new URL(start.body.authorizationUrl).searchParams.get('state'), code: 'code' });
    jest.spyOn(google, 'revoke').mockRejectedValueOnce(new Error('offline'));
    expect((await request(app).post('/calendar/oauth/disconnect').set('Authorization', bearer)).status).toBe(204);
  });

  it('routes malformed and unexpected OAuth failures safely', async () => {
    expect((await request(app).get('/calendar/oauth/callback')).status).toBe(400);
    expect((await request(app).post('/calendar/oauth/start').set('Authorization', bearer).send({})).status).toBe(400);
    jest.spyOn(google, 'authorizationUrl').mockImplementationOnce(() => { throw new Error('unexpected'); });
    expect((await request(app).post('/calendar/oauth/start').set('Authorization', bearer).send({ returnPath: '/' })).status).toBe(500);
  });

  it('rejects missing Google scopes and unavailable encryption key versions', async () => {
    google.scopes = ['openid'];
    let start = await request(app).post('/calendar/oauth/start').set('Authorization', bearer).send({ returnPath: '/' });
    expect((await request(app).get('/calendar/oauth/callback').query({ state: new URL(start.body.authorizationUrl).searchParams.get('state'), code: 'code' })).status).toBe(500);
    google.scopes = ['openid', 'https://www.googleapis.com/auth/calendar.events'];
    start = await request(app).post('/calendar/oauth/start').set('Authorization', bearer).send({ returnPath: '/' });
    await request(app).get('/calendar/oauth/callback').query({ state: new URL(start.body.authorizationUrl).searchParams.get('state'), code: 'code' });
    await GoogleOAuthGrantModel.updateOne({}, { $set: { keyVersion: 'missing' } });
    expect((await request(app).post('/calendar/oauth/disconnect').set('Authorization', bearer)).status).toBe(500);
  });

  it('fails closed when an OAuth attempt references a removed key', async () => {
    const start = await request(app).post('/calendar/oauth/start').set('Authorization', bearer).send({ returnPath: '/?existing=1' });
    await GoogleOAuthAttemptModel.updateOne({}, { $set: { keyVersion: 'removed' } });
    expect((await request(app).get('/calendar/oauth/callback').query({ state: new URL(start.body.authorizationUrl).searchParams.get('state'), code: 'code' })).status).toBe(500);
    expect(loadGoogleOAuthConfig({
      GOOGLE_CALENDAR_OAUTH_CLIENT_ID: 'client', GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: 'secret',
      GOOGLE_CALENDAR_OAUTH_CALLBACK_URL: 'https://app.example/callback',
      GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    }, 'production')).toMatchObject({ returnOrigins: ['https://app.example'] });
  });

  it('fails closed if the upserted calendar connection is unexpectedly unavailable', async () => {
    const start = await request(app).post('/calendar/oauth/start')
      .set('Authorization', bearer).send({ returnPath: '/' });
    jest.spyOn(CalendarConnectionModel, 'findOneAndUpdate').mockResolvedValueOnce(null);

    const callback = await request(app).get('/calendar/oauth/callback')
      .query({ state: new URL(start.body.authorizationUrl).searchParams.get('state'), code: 'code' });

    expect(callback.status).toBe(500);
    expect(callback.body.error).toBe('calendar_connection_create_failed');
  });

  it('appends callback status to an existing return query and revokes with access-token fallback', async () => {
    google.omitRefresh = true;
    const start = await request(app).post('/calendar/oauth/start').set('Authorization', bearer).send({ returnPath: '/settings?tab=calendar' });
    const callback = await request(app).get('/calendar/oauth/callback').query({ state: new URL(start.body.authorizationUrl).searchParams.get('state'), code: 'code' });
    expect(callback.headers.location).toBe('https://app.example.com/settings?tab=calendar&calendar=connected');
    await request(app).post('/calendar/oauth/disconnect').set('Authorization', bearer);
    expect(google.revoked).toEqual(['access-secret']);
  });

  it('rejects denied callbacks without echoing provider input', async () => {
    const response = await request(app).get('/calendar/oauth/callback')
      .query({ error: 'access_denied_sensitive', error_description: 'private provider details' });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('sensitive');
    expect(JSON.stringify(response.body)).not.toContain('private provider');
  });

  it('binds encrypted PKCE blobs to their tenant and state record with AES-GCM AAD', async () => {
    const first = await request(app).post('/calendar/oauth/start')
      .set('Authorization', bearer).send({ returnPath: '/' });
    const second = await request(app).post('/calendar/oauth/start')
      .set('Authorization', bearer).send({ returnPath: '/' });
    const attempts = await GoogleOAuthAttemptModel.find().sort({ createdAt: 1 })
      .select('+pkceCiphertext +pkceIv +pkceTag');
    attempts[0].pkceCiphertext = attempts[1].pkceCiphertext;
    attempts[0].pkceIv = attempts[1].pkceIv;
    attempts[0].pkceTag = attempts[1].pkceTag;
    await attempts[0].save();
    const state = new URL(first.body.authorizationUrl).searchParams.get('state')!;
    const callback = await request(app).get('/calendar/oauth/callback').query({ state, code: 'code' });

    expect(second.status).toBe(201);
    expect(callback.status).toBe(500);
    expect(await GoogleOAuthGrantModel.countDocuments()).toBe(0);
    expect(await CalendarConnectionModel.countDocuments()).toBe(0);
  });
});
