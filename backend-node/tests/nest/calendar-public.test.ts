import mongoose from 'mongoose';
import type { CreateAppOptions } from '../../src/app-options';
import type { GoogleCalendarService } from '../../src/application/googleCalendar';
import { createNestApp } from '../../src/nest-app';
import { CalendarConflictModel, CalendarConnectionModel } from '../../src/models/calendar';
import { TaskModel } from '../../src/models/task';
import { clearMongo, startMongo, stopMongo } from '../helpers/mongo';

describe('Nest Fastify public Calendar API', () => {
  const originalEnvironment = { ...process.env };
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
      oidcTokenVerifier: async (token) => ({
        tenantId: 'tenant-a', userId: 'owner-a', roles: [], projectIds: [],
        scopes: token === 'read' ? ['calendar:read']
          : token === 'write' ? ['calendar:write'] : ['calendar:read', 'calendar:write'],
      }),
    });
  });

  afterEach(clearMongo);
  afterAll(async () => {
    await app.close();
    await stopMongo();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
  });

  const request = (
    method: 'GET' | 'POST', url: string, token = 'both', payload?: object,
    headers: Record<string, string> = {},
  ) => app.inject({
    method, url, headers: { authorization: `Bearer ${token}`, ...headers },
    ...(payload ? { payload } : {}),
  });

  it('reports disconnected/connected status and enforces Calendar scopes', async () => {
    const disconnected = await request('GET', '/calendar/status');
    await CalendarConnectionModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', provider: 'google', calendarId: 'primary',
      credentialRef: `oauth-grant:${new mongoose.Types.ObjectId()}`, status: 'active',
    });
    const connected = await request('GET', '/calendar/status');
    const deniedRead = await request('GET', '/calendar/status', 'write');
    const deniedWrite = await request('POST', '/calendar/sync-requests', 'read', {});

    expect(disconnected.json()).toEqual({ status: 'disconnected', connection: null, canConnect: false });
    expect(connected.json()).toMatchObject({ status: 'connected', canConnect: false });
    expect(deniedRead.statusCode).toBe(403);
    expect(deniedWrite.statusCode).toBe(403);
  });

  it('preserves sync request preconditions and disconnected mapping', async () => {
    const missingKey = await request('POST', '/calendar/sync-requests', 'write', {});
    const disconnected = await request(
      'POST', '/calendar/sync-requests', 'write', {}, { 'idempotency-key': 'sync-1' },
    );
    expect(missingKey.statusCode).toBe(428);
    expect(missingKey.json()).toEqual({ error: 'Idempotency-Key is required' });
    expect(disconnected.statusCode).toBe(409);
    expect(disconnected.json()).toEqual({ error: 'Calendar is disconnected' });
  });

  it('validates event windows, binding/import payloads and resolution preconditions', async () => {
    const events = await request('GET', '/calendar/events?timeMin=bad&timeMax=bad', 'read');
    const preview = await request('POST', '/calendar/bindings/preview', 'read', {});
    const binding = await request('POST', '/calendar/bindings', 'write', {});
    const imports = await request('POST', '/calendar/imports', 'write', {}, {
      'idempotency-key': 'import-1',
    });
    const deletion = await request(
      'POST', `/calendar/deleted-bindings/${new mongoose.Types.ObjectId()}/resolve`, 'write', {},
    );
    const conflict = await request(
      'POST', `/calendar/conflicts/${new mongoose.Types.ObjectId()}/resolve`, 'write', {},
    );

    expect(events.statusCode).toBe(404);
    expect(events.json()).toEqual({ error: 'Calendar provider is unavailable' });
    expect(preview.statusCode).toBe(404);
    expect(binding.statusCode).toBe(404);
    expect(imports.statusCode).toBe(404);
    expect(deletion.statusCode).toBe(428);
    expect(conflict.statusCode).toBe(428);
  });

  it('lists only owner-scoped conflicts and deleted bindings', async () => {
    const task = await TaskModel.create({ tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Owner task' });
    await CalendarConflictModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', connectionId: new mongoose.Types.ObjectId(),
      bindingId: new mongoose.Types.ObjectId(), taskId: task._id, taskRevision: 0,
      providerRevision: 'etag', providerSnapshot: {}, status: 'open',
    });
    const conflicts = await request('GET', '/calendar/conflicts', 'read');
    const deleted = await request('GET', '/calendar/deleted-bindings', 'read');
    expect(conflicts.statusCode).toBe(200);
    expect(conflicts.json()).toHaveLength(1);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual([]);
  });

  it('delegates provider preview/events/import/link and maps provider failures', async () => {
    const provider = {
      candidateEvents: async () => ({ events: [{ id: 'event-1' }] }),
      previewLink: async () => ({ taskId: 'task-1', providerEventId: 'event-1' }),
      linkExisting: async (input: object) => ({ ...input, linked: true }),
      importSelected: async () => ({ imported: ['event-1'] }),
    } as unknown as GoogleCalendarService;
    const providerApp = await createNestApp({
      auditSink: { record: () => undefined },
      oidcTokenVerifier: async () => ({
        tenantId: 'tenant-a', userId: 'owner-a', roles: [], projectIds: [],
        scopes: ['calendar:read', 'calendar:write'],
      }),
      googleCalendarService: provider,
      calendarCanConnect: true,
    } as CreateAppOptions);
    await CalendarConnectionModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', provider: 'google', calendarId: 'primary',
      credentialRef: `oauth-grant:${new mongoose.Types.ObjectId()}`, status: 'active',
    });
    try {
      const auth = { authorization: 'Bearer both' };
      const events = await providerApp.inject({
        method: 'GET',
        url: '/calendar/events?timeMin=2026-08-01T00:00:00.000Z&timeMax=2026-08-31T00:00:00.000Z',
        headers: auth,
      });
      const preview = await providerApp.inject({
        method: 'POST', url: '/calendar/bindings/preview', headers: auth,
        payload: { taskId: 'task-1', providerEventId: 'event-1' },
      });
      expect(events.json()).toEqual({ events: [{ id: 'event-1' }] });
      expect(preview.json()).toEqual({ taskId: 'task-1', providerEventId: 'event-1' });
    } finally {
      await providerApp.close();
    }
  });
});
