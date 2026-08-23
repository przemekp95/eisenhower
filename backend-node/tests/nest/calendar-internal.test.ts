import { createHmac, randomUUID } from 'node:crypto';
import { createNestApp } from '../../src/nest-app';
import { clearMongo, startMongo, stopMongo } from '../helpers/mongo';

describe('Nest Fastify internal Calendar API', () => {
  const originalEnvironment = { ...process.env };
  const hmacKey = 'nest-internal-calendar-hmac-key-32-bytes-minimum';
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
      calendarInternalHmacKey: hmacKey,
      oidcTokenVerifier: async () => { throw new Error('internal routes must not invoke OIDC'); },
    });
  });

  afterEach(clearMongo);
  afterAll(async () => {
    await app.close();
    await stopMongo();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
  });

  it.each([
    ['/internal/calendar/inbound', 400, { error: 'Invalid calendar inbound command' }],
    ['/internal/calendar/sync/apply', 400, { error: 'Invalid calendar inbound command' }],
    ['/internal/calendar/sync/apply-batch', 400, { error: 'Invalid calendar inbound command batch' }],
    ['/internal/calendar/sync/reset', 400, { error: 'Invalid calendar sync reset' }],
    ['/internal/calendar/request', 400, { error: 'Invalid calendar sync request' }],
    ['/internal/calendar/outbound/result', 400, { error: 'Invalid calendar outbox acknowledgement' }],
    ['/internal/calendar/outbox/acknowledge', 400, { error: 'Invalid calendar outbox acknowledgement' }],
    ['/internal/calendar/notifications/validate', 403, { valid: false }],
    ['/internal/calendar/watch/renew', 400, { error: 'Invalid calendar watch renewal' }],
  ])('preserves validation for %s', async (path, status, body) => {
    const response = await signedPost(path, {});
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual(body);
  });

  it.each(['/internal/calendar/outbound/claim', '/internal/calendar/outbox/claim'])(
    'returns and replays an empty claim for %s', async (path) => {
      const requestId = randomUUID();
      const first = await signedPost(path, {}, requestId);
      const replay = await signedPost(path, {}, requestId);
      expect(first.statusCode).toBe(204);
      expect(replay.statusCode).toBe(204);
    },
  );

  it('returns empty reconciliation and missing internal status without OIDC', async () => {
    const reconciliation = await signedPost('/internal/calendar/reconciliation/claim', {});
    const status = await signedPost('/internal/calendar/status', {});
    expect(reconciliation.json()).toEqual({ jobs: [] });
    expect(status.statusCode).toBe(404);
    expect(status.json()).toEqual({ error: 'Calendar connection not found' });
  });

  it('binds the signature to exact raw JSON bytes and route aliases', async () => {
    const path = '/internal/calendar/inbound';
    const raw = '{ "tenantId": "tenant-a" }';
    const requestId = randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(path, raw, requestId, timestamp);
    const accepted = await app.inject({
      method: 'POST', url: path, payload: raw,
      headers: signedHeaders(requestId, timestamp, signature),
    });
    const changedBytes = await app.inject({
      method: 'POST', url: path, payload: '{}',
      headers: signedHeaders(randomUUID(), timestamp, signature),
    });
    expect(accepted.statusCode).toBe(400);
    expect(changedBytes.statusCode).toBe(401);
  });

  async function signedPost(path: string, payload: Record<string, unknown>, requestId = randomUUID()) {
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return app.inject({
      method: 'POST', url: path, payload: raw,
      headers: signedHeaders(requestId, timestamp, sign(path, raw, requestId, timestamp)),
    });
  }

  function sign(path: string, raw: string, requestId: string, timestamp: string) {
    return createHmac('sha256', hmacKey)
      .update(`v1\n${timestamp}\n${requestId}\nPOST\n${path}\n${raw}`).digest('hex');
  }

  function signedHeaders(requestId: string, timestamp: string, signature: string) {
    return {
      'content-type': 'application/json', 'x-eisenhower-timestamp': timestamp,
      'x-eisenhower-request-id': requestId, 'x-eisenhower-signature': signature,
    };
  }
});
