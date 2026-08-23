# Node HTTP Migration Map

Baseline oracle: `5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9` (Express 5.2.1). Candidate target: one NestJS 11 application using the Fastify 5 adapter. The machine-readable source is `backend-node/contracts/node-http-routes.json`; the captured wire evidence is `backend-node/contracts/express-5db1983-contract.json`.

## Cross-cutting baseline

- Request context: accept `X-Request-ID` matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`, otherwise generate it; return it on every response and correlate audit records.
- Proxy/rate limiting: trust exactly one proxy hop only in production; 60-second window; default maximum 120; standard `RateLimit-*` headers and exact 429 text response.
- Browser security: Helmet once; CORS allowlist from configuration; `credentials: false`; methods `GET, POST, PUT, DELETE, OPTIONS`; exact allowed/exposed headers. Bearer/OIDC with browser `credentials: 'omit'` means no ambient session-cookie authentication and no current CSRF-token contract. Trusted Origin remains mandatory for unsafe browser requests.
- Parsing: JSON limit `32kb`; retain exact raw bytes for internal Calendar HMAC; exact JSON 413 mapping.
- Authentication: public health and OAuth callback exceptions; otherwise static Bearer or OIDC. Authentication precedes trusted-Origin and scope decisions. Task and Calendar scopes remain endpoint-specific.
- Audit/errors: auth/ACL rejections are request-bound, tamper-evident and fail closed when audit is unavailable; exact 404 and production-safe 500 bodies remain stable.
- Persistence/integrations: MongoDB is canonical. HMAC replay receipts, idempotency receipts, Calendar outbox leases/retries/dead-letter, OAuth state, provider ETags, webhooks and reconciliation stay durable. n8n remains an asynchronous consumer only.

## Route inventory

Status values: `express-baseline` (captured oracle), `candidate-green` (differential Nest parity), `nest-final` (sole final owner). Every row must reach `nest-final` before Express removal is complete.

| Method | Path | Express owner | Final owner | Auth | Scope | Origin | Body | Side effects | Consumers | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| DELETE | `/tasks/:id` | tasks | TasksModule | bearer-or-oidc | tasks:write | unsafe-methods | none | deletes-trashed-task, updates-idempotency-receipt | packages/api-client, web, mobile | express-baseline |
| GET | `/calendar/conflicts` | calendar | CalendarModule | bearer-or-oidc | calendar:read | unsafe-methods | none | reads-conflicts | packages/api-client, web | express-baseline |
| GET | `/calendar/deleted-bindings` | calendar | CalendarModule | bearer-or-oidc | calendar:read | unsafe-methods | none | reads-deleted-bindings | packages/api-client, web | express-baseline |
| GET | `/calendar/events` | calendar | CalendarModule | bearer-or-oidc | calendar:read | unsafe-methods | none | reads-provider-events | packages/api-client, web | express-baseline |
| GET | `/calendar/oauth/callback` | googleOAuth | GoogleIntegrationModule | public | - | not-applicable | none | consumes-oauth-state, stores-grant, registers-watch | browser | express-baseline |
| GET | `/calendar/status` | calendar | CalendarModule | bearer-or-oidc | calendar:read | unsafe-methods | none | reads-calendar-state | packages/api-client, web | express-baseline |
| GET | `/health` | health | HealthModule | public | - | not-applicable | none | none | runtime-probes | express-baseline |
| GET | `/health/ready` | health | HealthModule | public | - | not-applicable | none | checks-database, checks-ai | runtime-probes | express-baseline |
| GET | `/tasks` | tasks | TasksModule | bearer-or-oidc | tasks:read | unsafe-methods | none | reads-tasks, emits-pagination | packages/api-client, web, mobile | express-baseline |
| GET | `/tasks/:id` | tasks | TasksModule | bearer-or-oidc | tasks:read | unsafe-methods | none | reads-task | packages/api-client, web, mobile | express-baseline |
| GET | `/tasks/delegated` | tasks | TasksModule | bearer-or-oidc | tasks:read | unsafe-methods | none | reads-tasks | packages/api-client, web, mobile | express-baseline |
| POST | `/calendar/bindings` | calendar | CalendarModule | bearer-or-oidc | calendar:write | unsafe-methods | json-32kb | writes-binding, updates-task, writes-outbox | packages/api-client, web | express-baseline |
| POST | `/calendar/bindings/preview` | calendar | CalendarModule | bearer-or-oidc | calendar:read | unsafe-methods | json-32kb | reads-task-and-provider-event | packages/api-client, web | express-baseline |
| POST | `/calendar/conflicts/:id/resolve` | calendar | CalendarModule | bearer-or-oidc | calendar:write | unsafe-methods | json-32kb | resolves-conflict, updates-task, writes-outbox | packages/api-client, web | express-baseline |
| POST | `/calendar/deleted-bindings/:id/resolve` | calendar | CalendarModule | bearer-or-oidc | calendar:write | unsafe-methods | json-32kb | resolves-provider-deletion, writes-outbox | packages/api-client, web | express-baseline |
| POST | `/calendar/imports` | calendar | CalendarModule | bearer-or-oidc | calendar:write | unsafe-methods | json-32kb | imports-provider-events, writes-idempotency-receipts | packages/api-client, web | express-baseline |
| POST | `/calendar/oauth/disconnect` | googleOAuth | GoogleIntegrationModule | bearer-or-oidc | calendar:write | unsafe-methods | json-32kb | revokes-grant, disconnects-calendar | packages/api-client, web | express-baseline |
| POST | `/calendar/oauth/start` | googleOAuth | GoogleIntegrationModule | bearer-or-oidc | calendar:write | unsafe-methods | json-32kb | creates-oauth-state | packages/api-client, web | express-baseline |
| POST | `/calendar/sync-requests` | calendar | CalendarModule | bearer-or-oidc | calendar:write | unsafe-methods | json-32kb | writes-sync-request | packages/api-client, web | express-baseline |
| POST | `/internal/calendar/inbound` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | applies-inbound-command | n8n | express-baseline |
| POST | `/internal/calendar/notifications/validate` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | validates-webhook, writes-sync-state | n8n | express-baseline |
| POST | `/internal/calendar/outbound/claim` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | leases-outbox | n8n | express-baseline |
| POST | `/internal/calendar/outbound/result` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | acknowledges-outbox | n8n | express-baseline |
| POST | `/internal/calendar/outbox/acknowledge` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | acknowledges-outbox | n8n | express-baseline |
| POST | `/internal/calendar/outbox/claim` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | leases-outbox | n8n | express-baseline |
| POST | `/internal/calendar/provider/changes` | googleCalendarProvider | GoogleIntegrationModule | internal-hmac | - | not-applicable | raw-json-32kb | reads-provider-changes | n8n | express-baseline |
| POST | `/internal/calendar/provider/outbound` | googleCalendarProvider | GoogleIntegrationModule | internal-hmac | - | not-applicable | raw-json-32kb | writes-provider-event | n8n | express-baseline |
| POST | `/internal/calendar/provider/watch` | googleCalendarProvider | GoogleIntegrationModule | internal-hmac | - | not-applicable | raw-json-32kb | registers-provider-watch | n8n | express-baseline |
| POST | `/internal/calendar/reconciliation/claim` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | leases-reconciliation | n8n | express-baseline |
| POST | `/internal/calendar/request` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | writes-sync-request | n8n | express-baseline |
| POST | `/internal/calendar/status` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | reads-internal-status | n8n | express-baseline |
| POST | `/internal/calendar/sync/apply` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | applies-inbound-command | n8n | express-baseline |
| POST | `/internal/calendar/sync/apply-batch` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | applies-inbound-batch | n8n | express-baseline |
| POST | `/internal/calendar/sync/reset` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | marks-full-resync | n8n | express-baseline |
| POST | `/internal/calendar/watch/renew` | calendarInternal | CalendarInternalModule | internal-hmac | - | not-applicable | raw-json-32kb | renews-watch-state | n8n | express-baseline |
| POST | `/tasks` | tasks | TasksModule | bearer-or-oidc | tasks:write | unsafe-methods | json-32kb | creates-task, writes-idempotency-receipt | packages/api-client, web, mobile | express-baseline |
| PUT | `/tasks/:id` | tasks | TasksModule | bearer-or-oidc | tasks:write | unsafe-methods | json-32kb | updates-task | packages/api-client, web, mobile | express-baseline |
| PUT | `/tasks/:id/delegation` | tasks | TasksModule | bearer-or-oidc | tasks:write | unsafe-methods | json-32kb | updates-delegation | packages/api-client, web, mobile | express-baseline |
| PUT | `/tasks/:id/delegation/status` | tasks | TasksModule | bearer-or-oidc | tasks:write | unsafe-methods | json-32kb | transitions-delegation | packages/api-client, web, mobile | express-baseline |
| PUT | `/tasks/:id/lifecycle` | tasks | TasksModule | bearer-or-oidc | tasks:write | unsafe-methods | json-32kb | transitions-lifecycle, writes-calendar-outbox | packages/api-client, web, mobile | express-baseline |
| PUT | `/tasks/:id/schedule` | tasks | TasksModule | bearer-or-oidc | tasks:write | unsafe-methods | json-32kb | updates-schedule, writes-calendar-outbox | packages/api-client, web, mobile | express-baseline |

## Differential evidence rules

The fixture captures one deterministic real-transport probe per route plus status, complete response headers/body and observable Mongo/audit state. Existing focused suites remain the deeper evidence for happy paths, validation matrices, concurrency, ETags/If-Match, idempotency, pagination, OAuth, provider failures and Calendar durability. Candidate comparisons may normalize only explicitly named generated headers or JSON paths; ordered arrays, error fields, scalar types and unknown fields are never discarded.

During a vertical slice, Express and Nest may temporarily call the same application service. A row becomes `candidate-green` only after the real Fastify adapter matches its fixture and focused suite. It becomes `nest-final` only after the Express handler is deleted and the route has exactly one runtime owner.

## Observed migration deltas

- Security substrate RED (Task 3): the Nest candidate initially had no global security metadata/guard or registered Fastify security pipeline; `tests/nest/security.test.ts` failed first on the absent `security.decorators` module. The next observed adapter mismatch was Fastify's pre-Nest plain-text 413 body. The single-owner pipeline now maps it in an `onSend` hook without overriding Nest's error handler. Security GREEN evidence: 7 Nest/Fastify differential groups plus 52 focused legacy auth/audit/app/config cases pass; build, typecheck and production dependency audit pass.
