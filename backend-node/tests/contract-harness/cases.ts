import { ContractCase, ContractMethod, RouteManifestEntry } from './types';

const bearer = { authorization: 'Bearer test-api-token' };
const invalidId = 'not-a-mongo-id';

function route(
  method: ContractMethod,
  path: string,
  currentRouter: string,
  finalModule: string,
  auth: RouteManifestEntry['auth'],
  scope: string | null,
  body: RouteManifestEntry['body'],
  sideEffects: string[],
  consumers: string[],
): RouteManifestEntry {
  return {
    method,
    path,
    currentRouter,
    finalModule,
    auth,
    scope,
    trustedOrigin: auth === 'bearer-or-oidc' ? 'unsafe-methods' : 'not-applicable',
    body,
    sideEffects,
    consumers,
  };
}

function contractCase(
  routeEntry: RouteManifestEntry,
  requestPath = routeEntry.path,
  body?: unknown,
  headers: Record<string, string> = {},
): ContractCase {
  return {
    route: routeEntry,
    request: {
      id: `${routeEntry.method.toLowerCase()}-${routeEntry.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`,
      method: routeEntry.method,
      path: requestPath,
      headers: routeEntry.auth === 'bearer-or-oidc' ? { ...bearer, ...headers } : headers,
      ...(body === undefined ? {} : { body }),
    },
    normalization: { generatedHeaders: ['date', 'x-request-id'] },
  };
}

const apiClients = ['packages/api-client', 'web', 'mobile'];
const calendarClients = ['packages/api-client', 'web'];
const n8n = ['n8n'];

export const CONTRACT_CASES: ContractCase[] = [
  contractCase(route('GET', '/health', 'health', 'HealthModule', 'public', null, 'none', [], ['runtime-probes'])),
  contractCase(route('GET', '/health/ready', 'health', 'HealthModule', 'public', null, 'none', ['checks-database', 'checks-ai'], ['runtime-probes'])),

  contractCase(route('GET', '/tasks/delegated', 'tasks', 'TasksModule', 'bearer-or-oidc', 'tasks:read', 'none', ['reads-tasks'], apiClients)),
  contractCase(route('GET', '/tasks/:id', 'tasks', 'TasksModule', 'bearer-or-oidc', 'tasks:read', 'none', ['reads-task'], apiClients), `/tasks/${invalidId}`),
  contractCase(route('GET', '/tasks', 'tasks', 'TasksModule', 'bearer-or-oidc', 'tasks:read', 'none', ['reads-tasks', 'emits-pagination'], apiClients)),
  contractCase(route('POST', '/tasks', 'tasks', 'TasksModule', 'bearer-or-oidc', 'tasks:write', 'json-32kb', ['creates-task', 'writes-idempotency-receipt'], apiClients), '/tasks', {}),
  contractCase(route('PUT', '/tasks/:id', 'tasks', 'TasksModule', 'bearer-or-oidc', 'tasks:write', 'json-32kb', ['updates-task'], apiClients), `/tasks/${invalidId}`, {}),
  contractCase(route('PUT', '/tasks/:id/lifecycle', 'tasks', 'TasksModule', 'bearer-or-oidc', 'tasks:write', 'json-32kb', ['transitions-lifecycle', 'writes-calendar-outbox'], apiClients), `/tasks/${invalidId}/lifecycle`, {}),
  contractCase(route('PUT', '/tasks/:id/schedule', 'tasks', 'TasksModule', 'bearer-or-oidc', 'tasks:write', 'json-32kb', ['updates-schedule', 'writes-calendar-outbox'], apiClients), `/tasks/${invalidId}/schedule`, {}),
  contractCase(route('PUT', '/tasks/:id/delegation', 'tasks', 'TasksModule', 'bearer-or-oidc', 'tasks:write', 'json-32kb', ['updates-delegation'], apiClients), `/tasks/${invalidId}/delegation`, {}),
  contractCase(route('PUT', '/tasks/:id/delegation/status', 'tasks', 'TasksModule', 'bearer-or-oidc', 'tasks:write', 'json-32kb', ['transitions-delegation'], apiClients), `/tasks/${invalidId}/delegation/status`, {}),
  contractCase(route('DELETE', '/tasks/:id', 'tasks', 'TasksModule', 'bearer-or-oidc', 'tasks:write', 'none', ['deletes-trashed-task', 'updates-idempotency-receipt'], apiClients), `/tasks/${invalidId}`),

  contractCase(route('GET', '/calendar/status', 'calendar', 'CalendarModule', 'bearer-or-oidc', 'calendar:read', 'none', ['reads-calendar-state'], calendarClients)),
  contractCase(route('POST', '/calendar/sync-requests', 'calendar', 'CalendarModule', 'bearer-or-oidc', 'calendar:write', 'json-32kb', ['writes-sync-request'], calendarClients), '/calendar/sync-requests', {}),
  contractCase(route('GET', '/calendar/events', 'calendar', 'CalendarModule', 'bearer-or-oidc', 'calendar:read', 'none', ['reads-provider-events'], calendarClients), '/calendar/events'),
  contractCase(route('POST', '/calendar/bindings/preview', 'calendar', 'CalendarModule', 'bearer-or-oidc', 'calendar:read', 'json-32kb', ['reads-task-and-provider-event'], calendarClients), '/calendar/bindings/preview', {}),
  contractCase(route('POST', '/calendar/bindings', 'calendar', 'CalendarModule', 'bearer-or-oidc', 'calendar:write', 'json-32kb', ['writes-binding', 'updates-task', 'writes-outbox'], calendarClients), '/calendar/bindings', {}),
  contractCase(route('POST', '/calendar/imports', 'calendar', 'CalendarModule', 'bearer-or-oidc', 'calendar:write', 'json-32kb', ['imports-provider-events', 'writes-idempotency-receipts'], calendarClients), '/calendar/imports', {}),
  contractCase(route('GET', '/calendar/conflicts', 'calendar', 'CalendarModule', 'bearer-or-oidc', 'calendar:read', 'none', ['reads-conflicts'], calendarClients)),
  contractCase(route('GET', '/calendar/deleted-bindings', 'calendar', 'CalendarModule', 'bearer-or-oidc', 'calendar:read', 'none', ['reads-deleted-bindings'], calendarClients)),
  contractCase(route('POST', '/calendar/deleted-bindings/:id/resolve', 'calendar', 'CalendarModule', 'bearer-or-oidc', 'calendar:write', 'json-32kb', ['resolves-provider-deletion', 'writes-outbox'], calendarClients), `/calendar/deleted-bindings/${invalidId}/resolve`, {}),
  contractCase(route('POST', '/calendar/conflicts/:id/resolve', 'calendar', 'CalendarModule', 'bearer-or-oidc', 'calendar:write', 'json-32kb', ['resolves-conflict', 'updates-task', 'writes-outbox'], calendarClients), `/calendar/conflicts/${invalidId}/resolve`, {}),

  contractCase(route('GET', '/calendar/oauth/callback', 'googleOAuth', 'GoogleIntegrationModule', 'public', null, 'none', ['consumes-oauth-state', 'stores-grant', 'registers-watch'], ['browser']), '/calendar/oauth/callback'),
  contractCase(route('POST', '/calendar/oauth/start', 'googleOAuth', 'GoogleIntegrationModule', 'bearer-or-oidc', 'calendar:write', 'json-32kb', ['creates-oauth-state'], calendarClients), '/calendar/oauth/start', {}),
  contractCase(route('POST', '/calendar/oauth/disconnect', 'googleOAuth', 'GoogleIntegrationModule', 'bearer-or-oidc', 'calendar:write', 'json-32kb', ['revokes-grant', 'disconnects-calendar'], calendarClients), '/calendar/oauth/disconnect', {}),

  ...[
    ['/internal/calendar/inbound', ['applies-inbound-command']],
    ['/internal/calendar/sync/apply', ['applies-inbound-command']],
    ['/internal/calendar/sync/apply-batch', ['applies-inbound-batch']],
    ['/internal/calendar/sync/reset', ['marks-full-resync']],
    ['/internal/calendar/request', ['writes-sync-request']],
    ['/internal/calendar/outbound/claim', ['leases-outbox']],
    ['/internal/calendar/outbox/claim', ['leases-outbox']],
    ['/internal/calendar/outbound/result', ['acknowledges-outbox']],
    ['/internal/calendar/outbox/acknowledge', ['acknowledges-outbox']],
    ['/internal/calendar/notifications/validate', ['validates-webhook', 'writes-sync-state']],
    ['/internal/calendar/watch/renew', ['renews-watch-state']],
    ['/internal/calendar/reconciliation/claim', ['leases-reconciliation']],
    ['/internal/calendar/status', ['reads-internal-status']],
  ].map(([path, sideEffects]) => contractCase(route(
    'POST', path as string, 'calendarInternal', 'CalendarInternalModule', 'internal-hmac', null,
    'raw-json-32kb', sideEffects as string[], n8n,
  ), path as string, {})),

  ...[
    ['/internal/calendar/provider/outbound', ['writes-provider-event']],
    ['/internal/calendar/provider/changes', ['reads-provider-changes']],
    ['/internal/calendar/provider/watch', ['registers-provider-watch']],
  ].map(([path, sideEffects]) => contractCase(route(
    'POST', path as string, 'googleCalendarProvider', 'GoogleIntegrationModule', 'internal-hmac', null,
    'raw-json-32kb', sideEffects as string[], n8n,
  ), path as string, {})),
];
