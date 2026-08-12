import request from 'supertest';
import { createApp } from '../src/app';
import { GoogleOAuthPort, GoogleTokenSet, loadGoogleOAuthConfig } from '../src/application/googleOAuth';
import { CalendarConnectionModel, GoogleOAuthAttemptModel, GoogleOAuthGrantModel } from '../src/models/calendar';
import { clearMongo, startMongo, stopMongo } from './helpers/mongo';
import { TaskModel } from '../src/models/task';

class FakeGoogleOAuth implements GoogleOAuthPort {
  revoked: string[] = [];
  authorizationUrl(input: { state: string; codeChallenge: string; callbackUrl: string; clientId: string }) {
    return `https://accounts.google.test/auth?state=${input.state}&code_challenge=${input.codeChallenge}`;
  }
  async exchangeCode(): Promise<GoogleTokenSet> {
    return {
      accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: new Date(Date.now() + 3600_000),
      googleSubject: 'google-user-123', scopes: ['openid', 'https://www.googleapis.com/auth/calendar.events'],
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
  afterEach(async () => { google.revoked = []; await clearMongo(); });
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
