import {
  createCipheriv, createDecipheriv, createHash, randomBytes,
} from 'node:crypto';
import mongoose from 'mongoose';
import {
  CalendarConnectionModel,
  CalendarOutboxModel,
  CalendarSyncStateModel,
  GoogleOAuthAttemptModel,
  GoogleOAuthGrantModel,
} from '../models/calendar';

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  googleSubject: string;
  scopes: string[];
}

export interface GoogleOAuthPort {
  authorizationUrl(input: {
    state: string; codeChallenge: string; callbackUrl: string; clientId: string;
  }): string;
  exchangeCode(input: {
    code: string; codeVerifier: string; callbackUrl: string; clientId: string; clientSecret: string;
  }): Promise<GoogleTokenSet>;
  revoke(token: string): Promise<void>;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  encryptionKeys: Record<string, Buffer>;
  currentKeyVersion: string;
  returnOrigins: string[];
}

export class GoogleOAuthHttpClient implements GoogleOAuthPort {
  authorizationUrl(input: { state: string; codeChallenge: string; callbackUrl: string; clientId: string }) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: input.clientId, redirect_uri: input.callbackUrl, response_type: 'code',
      scope: 'openid https://www.googleapis.com/auth/calendar.events', access_type: 'offline',
      prompt: 'consent', state: input.state, code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: { code: string; codeVerifier: string; callbackUrl: string; clientId: string; clientSecret: string }) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code, code_verifier: input.codeVerifier, redirect_uri: input.callbackUrl,
        client_id: input.clientId, client_secret: input.clientSecret, grant_type: 'authorization_code',
      }), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('google_oauth_exchange_failed');
    const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!body.access_token || !body.refresh_token) throw new Error('google_oauth_token_set_incomplete');
    const profile = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${body.access_token}` }, signal: AbortSignal.timeout(5_000),
    });
    if (!profile.ok) throw new Error('google_oauth_subject_failed');
    const identity = await profile.json() as { sub?: string };
    if (!identity.sub) throw new Error('google_oauth_subject_missing');
    return {
      accessToken: body.access_token, refreshToken: body.refresh_token,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
      googleSubject: identity.sub, scopes: (body.scope ?? '').split(/\s+/).filter(Boolean),
    };
  }

  async revoke(token: string) {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }), signal: AbortSignal.timeout(5_000),
    });
  }
}

export interface Encrypted { ciphertext: string; iv: string; tag: string }

export function encryptGoogleSecret(key: Buffer, value: unknown, aad: string): Encrypted {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function decryptGoogleSecret<T>(key: Buffer, value: Encrypted, aad: string): T {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final(),
  ]).toString('utf8')) as T;
}

function sha(value: string) { return createHash('sha256').update(value).digest('hex'); }
function base64url(value: Buffer) { return value.toString('base64url'); }

function safeReturnUrl(path: string, origins: string[]) {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('unsafe_return_path');
  return new URL(path, origins[0]).toString();
}

export class GoogleOAuthService {
  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly port: GoogleOAuthPort,
    private readonly onConnected?: (connectionId: string) => Promise<void>,
  ) {
    if (!config.clientId || !config.clientSecret || !config.callbackUrl || !config.currentKeyVersion) {
      throw new Error('Google OAuth configuration is incomplete.');
    }
    const callback = new URL(config.callbackUrl);
    if (callback.protocol !== 'https:') throw new Error('Google OAuth callback must use HTTPS.');
    if (!config.returnOrigins.length || config.returnOrigins.some((origin) => new URL(origin).origin !== origin)) {
      throw new Error('Google OAuth return origins must be exact origins.');
    }
    const key = config.encryptionKeys[config.currentKeyVersion];
    if (!key || key.length !== 32) throw new Error('Google OAuth encryption key must contain 32 bytes.');
  }

  async start(scope: { tenantId: string; ownerId: string }, returnPath: string) {
    const state = base64url(randomBytes(32));
    const stateHash = sha(state);
    const verifier = base64url(randomBytes(48));
    const encrypted = encryptGoogleSecret(
      this.config.encryptionKeys[this.config.currentKeyVersion], verifier,
      `google-oauth-pkce-v1\0${scope.tenantId}\0${scope.ownerId}\0${stateHash}`,
    );
    const returnUrl = safeReturnUrl(returnPath, this.config.returnOrigins);
    await GoogleOAuthAttemptModel.create({
      ...scope, stateHash, pkceCiphertext: encrypted.ciphertext,
      pkceIv: encrypted.iv, pkceTag: encrypted.tag, keyVersion: this.config.currentKeyVersion,
      returnUrl, expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return {
      authorizationUrl: this.port.authorizationUrl({
        state, codeChallenge: base64url(createHash('sha256').update(verifier).digest()),
        callbackUrl: this.config.callbackUrl, clientId: this.config.clientId,
      }),
    };
  }

  async callback(state: string, code: string) {
    const attempt = await GoogleOAuthAttemptModel.findOneAndUpdate(
      { stateHash: sha(state), consumedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
      { $set: { consumedAt: new Date() } },
      { returnDocument: 'after' },
    ).select('+pkceCiphertext +pkceIv +pkceTag');
    if (!attempt) throw new Error('invalid_oauth_state');
    const key = this.config.encryptionKeys[attempt.keyVersion];
    if (!key) throw new Error('oauth_key_unavailable');
    const verifier = decryptGoogleSecret<string>(key, {
      ciphertext: attempt.pkceCiphertext, iv: attempt.pkceIv, tag: attempt.pkceTag,
    }, `google-oauth-pkce-v1\0${attempt.tenantId}\0${attempt.ownerId}\0${attempt.stateHash}`);
    const tokens = await this.port.exchangeCode({
      code, codeVerifier: verifier, callbackUrl: this.config.callbackUrl,
      clientId: this.config.clientId, clientSecret: this.config.clientSecret,
    });
    if (!tokens.scopes.includes('openid')
      || !tokens.scopes.includes('https://www.googleapis.com/auth/calendar.events')) {
      throw new Error('google_oauth_required_scope_missing');
    }
    const sealed = encryptGoogleSecret(
      key, tokens,
      `google-oauth-token-v1\0${attempt.tenantId}\0${attempt.ownerId}\0${tokens.googleSubject}`,
    );
    const session = await mongoose.startSession();
    let grantId = '';
    let connectionId = '';
    try {
      await session.withTransaction(async () => {
        await GoogleOAuthGrantModel.updateMany(
          { tenantId: attempt.tenantId, ownerId: attempt.ownerId, status: 'active' },
          { $set: { status: 'revoked', revokedAt: new Date() } }, { session },
        );
        const [grant] = await GoogleOAuthGrantModel.create([{
          tenantId: attempt.tenantId, ownerId: attempt.ownerId,
          googleSubject: tokens.googleSubject, scopes: tokens.scopes,
          tokenCiphertext: sealed.ciphertext, tokenIv: sealed.iv, tokenTag: sealed.tag,
          keyVersion: attempt.keyVersion, status: 'active',
        }], { session });
        grantId = grant.id;
        const connection = await CalendarConnectionModel.findOneAndUpdate(
          { tenantId: attempt.tenantId, ownerId: attempt.ownerId, provider: 'google', calendarId: 'primary' },
          { $set: { credentialRef: `oauth-grant:${grant.id}`, status: 'active' } },
          { upsert: true, session, setDefaultsOnInsert: true, returnDocument: 'after' },
        );
        if (!connection) throw new Error('calendar_connection_create_failed');
        connectionId = connection.id;
        await CalendarSyncStateModel.findOneAndUpdate(
          { tenantId: attempt.tenantId, ownerId: attempt.ownerId, connectionId: connection._id },
          { $set: { fullResyncRequired: true, lastRequestedAt: new Date() } },
          { upsert: true, setDefaultsOnInsert: true, session },
        );
        await CalendarOutboxModel.create(
          [{
            eventId: `calendar-connect:${connection.id}:${grant.id}`,
            tenantId: attempt.tenantId,
            ownerId: attempt.ownerId,
            aggregateId: connection.id,
            aggregateRevision: 0,
            type: 'calendar.sync.requested',
            payload: { connectionId: connection.id },
            status: 'pending',
          }],
          { session },
        );
      });
    } finally { await session.endSession(); }
    if (this.onConnected && connectionId) await this.onConnected(connectionId);
    return { returnUrl: `${attempt.returnUrl}${attempt.returnUrl.includes('?') ? '&' : '?'}calendar=connected` };
  }

  async disconnect(scope: { tenantId: string; ownerId: string }) {
    const grant = await GoogleOAuthGrantModel.findOne({ ...scope, status: 'active' })
      .select('+tokenCiphertext +tokenIv +tokenTag');
    if (!grant) return;
    const key = this.config.encryptionKeys[grant.keyVersion];
    if (!key) throw new Error('oauth_key_unavailable');
    const tokens = decryptGoogleSecret<GoogleTokenSet>(key, {
      ciphertext: grant.tokenCiphertext, iv: grant.tokenIv, tag: grant.tokenTag,
    }, `google-oauth-token-v1\0${grant.tenantId}\0${grant.ownerId}\0${grant.googleSubject}`);
    grant.status = 'revoked'; grant.revokedAt = new Date(); await grant.save();
    await CalendarConnectionModel.updateMany(
      { ...scope, credentialRef: `oauth-grant:${grant.id}` }, { $set: { status: 'revoked' } },
    );
    try { await this.port.revoke(tokens.refreshToken ?? tokens.accessToken); } catch { /* local revoke is authoritative */ }
  }
}

export function loadGoogleOAuthConfig(env: NodeJS.ProcessEnv, nodeEnv: string): GoogleOAuthConfig | null {
  const names = ['GOOGLE_CALENDAR_OAUTH_CLIENT_ID', 'GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET', 'GOOGLE_CALENDAR_OAUTH_CALLBACK_URL', 'GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY'] as const;
  if (!names.some((name) => env[name])) return null;
  if (names.some((name) => !env[name]?.trim())) throw new Error('All Google Calendar OAuth settings are required together.');
  const callback = new URL(env.GOOGLE_CALENDAR_OAUTH_CALLBACK_URL!);
  const localhostDev = nodeEnv !== 'production' && callback.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(callback.hostname);
  if (callback.protocol !== 'https:' && !localhostDev) throw new Error('Google Calendar OAuth callback must use HTTPS.');
  const key = Buffer.from(env.GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY!, 'base64');
  if (key.length !== 32) throw new Error('Google Calendar OAuth encryption key must decode to exactly 32 bytes.');
  const returnOrigin = env.GOOGLE_CALENDAR_OAUTH_RETURN_ORIGIN?.trim() || callback.origin;
  return {
    clientId: env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID!, clientSecret: env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET!,
    callbackUrl: callback.toString(), encryptionKeys: { v1: key }, currentKeyVersion: 'v1',
    returnOrigins: [new URL(returnOrigin).origin],
  };
}
