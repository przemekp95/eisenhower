import mongoose from 'mongoose';
import request from '../helpers/http-test-client';
import { AuditEvent } from '../../src/audit';
import { createApp } from '../../src/app';
import { GoogleCalendarPort } from '../../src/application/googleCalendar';
import { GoogleOAuthPort } from '../../src/application/googleOAuth';
import { clearMongo, startMongo, stopMongo } from '../helpers/mongo';
import { ContractRequest, ContractResponse, ContractTarget } from './types';

const HMAC_KEY = 'contract-harness-calendar-key-at-least-32-bytes';

const oauthPort: GoogleOAuthPort = {
  authorizationUrl: ({ state }) => `https://accounts.example.test/authorize?state=${state}`,
  exchangeCode: async () => ({
    accessToken: 'access-token', refreshToken: 'refresh-token',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'), googleSubject: 'google-user',
    scopes: ['openid', 'https://www.googleapis.com/auth/calendar.events'],
  }),
  revoke: async () => undefined,
};

const calendarPort: GoogleCalendarPort = {
  refresh: async (tokens) => tokens,
  createEvent: async () => ({ providerEventId: 'provider-event', providerEtag: 'provider-etag' }),
  updateEvent: async () => ({ providerEventId: 'provider-event', providerEtag: 'provider-etag' }),
  deleteEvent: async () => ({ providerEventId: 'provider-event', providerEtag: 'provider-etag' }),
  listChanges: async () => ({ events: [], nextSyncToken: 'sync-token' }),
  watch: async () => ({
    channelId: 'channel-id', resourceId: 'resource-id', expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  }),
  listEvents: async () => ({ events: [] }),
  getEvent: async () => ({
    id: 'provider-event', etag: 'provider-etag', title: 'Provider event',
    start: '2030-01-01T10:00:00.000Z', end: '2030-01-01T10:30:00.000Z', timeZone: 'UTC',
  }),
};

function dispatch(app: Awaited<ReturnType<typeof createApp>>, input: ContractRequest) {
  switch (input.method) {
    case 'GET': return request(app).get(input.path);
    case 'HEAD': return request(app).head(input.path);
    case 'OPTIONS': return request(app).options(input.path);
    case 'POST': return request(app).post(input.path);
    case 'PUT': return request(app).put(input.path);
    case 'DELETE': return request(app).delete(input.path);
  }
}

export async function createNestTarget(): Promise<ContractTarget> {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalToken = process.env.EISENHOWER_API_TOKEN;
  process.env.NODE_ENV = 'test';
  process.env.EISENHOWER_API_TOKEN = 'test-api-token';
  await startMongo();
  let auditEvents: AuditEvent[] = [];
  const createTargetApp = () => createApp({
    aiHealthChecker: async () => 'healthy',
    databaseStatusResolver: () => 'connected',
    auditSink: { record: (event) => { auditEvents.push(event); } },
    calendarInternalHmacKey: HMAC_KEY,
    googleOAuthConfig: {
      clientId: 'client-id', clientSecret: 'client-secret',
      callbackUrl: 'https://tasks.example.com/calendar/oauth/callback',
      encryptionKeys: { v1: Buffer.alloc(32, 7) }, currentKeyVersion: 'v1',
      returnOrigins: ['https://tasks.example.com'],
    },
    googleOAuthPort: oauthPort,
    googleCalendarConfig: { watchCallbackUrls: ['https://hooks.example.com/calendar'] },
    googleCalendarPort: calendarPort,
  });

  return {
    request: async (input): Promise<ContractResponse> => {
      const app = await createTargetApp();
      let response;
      try {
        let pending = dispatch(app, input);
        for (const [name, value] of Object.entries(input.headers ?? {})) pending = pending.set(name, value);
        if (input.body !== undefined) pending = pending.send(input.body as string | object);
        response = await pending;
      } finally {
        await app.close();
      }
      const collectionCounts: Record<string, number> = {};
      for (const [name, collection] of Object.entries(mongoose.connection.collections)) {
        const count = await collection.countDocuments({});
        if (count > 0) collectionCounts[name] = count;
      }
      const contentType = String(response.headers['content-type'] ?? '');
      return {
        status: response.status,
        headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [
          name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value),
        ])),
        rawBody: response.text ?? '',
        jsonBody: contentType.includes('application/json') ? response.body as unknown : null,
        state: { collectionCounts, auditEvents: [...auditEvents] },
      };
    },
    reset: async () => {
      await clearMongo();
      auditEvents = [];
    },
    close: async () => {
      await stopMongo();
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalToken === undefined) delete process.env.EISENHOWER_API_TOKEN;
      else process.env.EISENHOWER_API_TOKEN = originalToken;
    },
  };
}
