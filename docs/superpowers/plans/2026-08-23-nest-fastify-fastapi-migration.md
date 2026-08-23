# NestJS/Fastify and FastAPI Boundary Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Node Express transport with one NestJS/Fastify application, modularize the FastAPI composition root without changing AI/RAG ownership, and prove contract parity, measured performance and local rollback.

**Architecture:** Capture the exact Express behavior first, then replace one vertical HTTP slice at a time behind existing application ports and services. Nest owns modules, DI and HTTP orchestration; Fastify owns server-level plugins; FastAPI remains the synchronous AI/RAG boundary and is split into focused factory, middleware, schema and router modules.

**Tech Stack:** Node.js 24, TypeScript 5.7, NestJS 11.2.1, Fastify 5.11.3, Mongoose 9, Jest 30, Cucumber 13, Python 3.12 local verification, FastAPI 0.141.1, Pydantic 2.13.4, pytest 9.

**Spec:** `docs/superpowers/specs/2026-08-23-nest-fastify-fastapi-migration-design.md`

## Global Constraints

- Work only in the existing isolated worktree; do not create a second worktree, stash, push, open a PR, promote refs, publish, deploy or activate runtime.
- Preserve exact baseline `5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9` as the Express oracle and rollback source. Current local implementation commits descend from that SHA.
- Keep TASK-065 In Progress and unchanged. Track all migration work under TASK-066.
- Use Node.js 24. Pin `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-fastify` and `@nestjs/testing` to `11.2.1`; pin direct `fastify` to `5.11.3` to match `@nestjs/platform-fastify`.
- Pin `@fastify/helmet` `13.1.1`, `@fastify/cors` `11.3.0`, `@fastify/rate-limit` `11.2.0`, `class-validator` `0.15.1`, `class-transformer` `0.5.1`, `reflect-metadata` `0.2.2` and `rxjs` `7.8.2`.
- Prefer Nest/Fastify implementations for technical concerns, but preserve wire contracts and durable guarantees. Register one owner for each concern.
- Keep MongoDB canonical, Qdrant rebuildable and n8n asynchronous-only. Do not introduce Redis, a broker, Django, Flask or an irreversible data migration.
- Do not place Nest, Fastify, FastAPI, Pydantic, Qdrant or provider SDK types in domain/application ports or canonical payloads.
- Every production change follows observed RED, minimal GREEN and refactor. Read `superpowers:test-driven-development/writing-good-tests.md` before changing the first test.
- Run `make prepare-verify` before any direct package test in a fresh worktree. It passed at plan time; rerun only when its hash-bound inputs require it.
- Keep commits small and intentional. Each task ends with the exact focused verification listed below.
- A passing test proves behavior, not historical TDD. Do not claim DDD, CQRS or BDD beyond the concrete boundaries and executable scenarios.

## Primary documentation checked

- Nest Fastify adapter and platform-specific package rule: `https://docs.nestjs.com/techniques/performance`
- Nest raw body and Fastify body-limit configuration: `https://docs.nestjs.com/faq/raw-body`
- Nest validation, CORS, Helmet and rate limiting: `https://docs.nestjs.com/techniques/validation`, `https://docs.nestjs.com/security/cors`, `https://docs.nestjs.com/techniques/security`, `https://docs.nestjs.com/security/rate-limiting`
- Nest testing utilities: `https://docs.nestjs.com/fundamentals/testing`
- Fastify server options and injection: `https://fastify.dev/docs/latest/Reference/Server/`, `https://fastify.dev/docs/latest/Guides/Testing/`

The npm registry was queried on 2026-08-23 for the exact versions above. The plan deliberately uses Fastify `5.11.3`, the version required by `@nestjs/platform-fastify@11.2.1`, rather than independently selecting Fastify `5.12.1`.

## Target file structure

### Node application

- `backend-node/src/app-options.ts` — framework-neutral dependency overrides used by runtime and tests.
- `backend-node/src/app.module.ts` — thin dynamic root module.
- `backend-node/src/nest-app.ts` — temporary Nest factory during migration; deleted after `src/app.ts` becomes the final factory.
- `backend-node/src/app.ts` — final `createApp()` Nest/Fastify factory.
- `backend-node/src/server.ts` — production listen/shutdown lifecycle.
- `backend-node/src/platform/tokens.ts` — DI tokens for ports and overrides.
- `backend-node/src/platform/http/fastify-platform.ts` — Fastify adapter options and plugin registration.
- `backend-node/src/platform/http/request-context.ts` — validated request ID and framework-neutral request context.
- `backend-node/src/platform/http/http-error.filter.ts` — exact global HTTP error mapping.
- `backend-node/src/platform/http/http-test-client.ts` — test-only injection facade replacing Supertest chains.
- `backend-node/src/modules/health/*` — liveness/readiness controller, service and module.
- `backend-node/src/modules/security/*` — auth, scopes, Origin, audit, decorators and module.
- `backend-node/src/modules/tasks/*` — query/command controllers, DTOs and module.
- `backend-node/src/application/tasks/*` — transport-free task query/command orchestration.
- `backend-node/src/modules/calendar/*` — public Calendar controllers/DTOs/module.
- `backend-node/src/modules/google/*` — OAuth and provider controllers/module.
- `backend-node/src/modules/calendar-internal/*` — HMAC guard plus inbound, outbox and operations controllers.

### Node contract, benchmark and rollback evidence

- `backend-node/contracts/node-http-routes.json` — machine-readable route/middleware/consumer map.
- `backend-node/contracts/express-5db1983-contract.json` — normalized exact Express baseline.
- `backend-node/tests/contract-harness/*` — transport-independent cases, targets and normalizers.
- `benchmarks/http-migration/*` — deterministic workloads, fixture server, process sampler, alternating exact-baseline/candidate runner and report generator.
- `benchmarks/results/nest-fastify-migration.json` — raw machine-readable benchmark samples and environment metadata.
- `scripts/rehearse-node-transport-rollback.mjs` — shared-data rollback rehearsal.
- `docs/architecture/node-http-migration-map.md` — human-readable migration map.
- `docs/benchmarks/2026-08-23-express-vs-nest-fastify.md` — measured results and limits.
- `docs/runbooks/node-transport-rollback.md` and `docs/evidence/2026-08-23-node-transport-rollback.md` — exact local rollback procedure and rehearsal evidence.

### FastAPI application

- `backend-ai/app/http/schemas.py` — strict HTTP Pydantic request schemas.
- `backend-ai/app/http/composition.py` — `AppDependencies` and lazy dependency construction.
- `backend-ai/app/http/middleware.py` — request context, authentication/Origin and audit middleware registration.
- `backend-ai/app/http/errors.py` — exception-handler registration.
- `backend-ai/app/http/health.py` — root, metrics and health.
- `backend-ai/app/http/analysis.py` — v2 and legacy analysis/classification.
- `backend-ai/app/http/knowledge.py` — search, answer and capabilities.
- `backend-ai/app/http/ocr.py` — OCR and batch endpoints.
- `backend-ai/app/http/internal.py` — webhook and queued internal RAG jobs.
- `backend-ai/app/http/training.py` — examples, feedback, retraining and training-data administration.
- `backend-ai/app/http/operator.py` — operator capabilities and provider state.
- `backend-ai/app/http/factory.py` — thin import-safe `create_app` orchestration.
- `backend-ai/app/main.py` — compatibility re-exports only.
- `backend-ai/tests/fixtures/main-openapi-baseline.json` — normalized OpenAPI parity fixture.

---

### Task 1: Freeze the Express route and contract baseline

**Files:**
- Create: `backend-node/contracts/node-http-routes.json`
- Create: `backend-node/contracts/express-5db1983-contract.json`
- Create: `backend-node/tests/contract-harness/types.ts`
- Create: `backend-node/tests/contract-harness/normalizers.ts`
- Create: `backend-node/tests/contract-harness/cases.ts`
- Create: `backend-node/tests/contract-harness/express-target.ts`
- Create: `backend-node/tests/contract-harness/baseline.test.ts`
- Create: `backend-node/scripts/capture-contract-baseline.ts`
- Create: `docs/architecture/node-http-migration-map.md`
- Modify: `backend-node/package.json`
- Modify: `backend-node/package-lock.json`

**Interfaces:**
- Consumes: existing synchronous `createApp(options: CreateAppOptions)` and Mongoose models.
- Produces:

```ts
export interface ContractRequest {
  id: string;
  method: 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ContractResponse {
  status: number;
  headers: Record<string, string>;
  rawBody: string;
  jsonBody: unknown | null;
  state: Record<string, unknown>;
}

export interface ContractTarget {
  request(input: ContractRequest): Promise<ContractResponse>;
  reset(): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write the failing inventory and normalization tests**

Add tests that extract every `router.get/post/put/delete` registration from `src/routes`, prepend its mount path from `src/app.ts`, and compare the result with `node-http-routes.json`. Add a normalizer test proving that only `date`, generated `x-request-id`, generated Mongo IDs and explicitly listed timestamps change; ordered arrays, error fields, scalar types and contract headers remain untouched.

```ts
expect(routeManifest.map(({ method, path }) => `${method} ${path}`).sort())
  .toEqual(extractExpressRoutes(repositoryRoot));
expect(normalizeResponse(sample).jsonBody).toEqual({
  error: 'Revision conflict', details: ['If-Match is stale'],
});
```

- [ ] **Step 2: Run RED and confirm the missing manifest/fixture is the failure**

Run: `cd backend-node && npm test -- tests/contract-harness/baseline.test.ts`

Expected: FAIL because `contracts/node-http-routes.json` and `contracts/express-5db1983-contract.json` do not exist. A syntax, Mongo startup or module-resolution error is not the expected RED.

- [ ] **Step 3: Implement the harness, map and capture command**

Create cases for all health, task, Calendar, OAuth and internal Calendar routes. Each case records status, exact JSON/text body, security/CORS/rate-limit/request-ID headers and relevant Mongo/audit/outbox/replay state. The capture command must refuse to label a fixture with the baseline SHA unless this is true:

```ts
const changed = execFileSync('git', [
  'diff', '--name-only', BASELINE_SHA, '--',
  'backend-node/src', 'backend-node/package.json', 'backend-node/package-lock.json',
], { encoding: 'utf8' }).trim();
if (changed) throw new Error(`Express baseline sources drifted:\n${changed}`);
```

The migration map must list route, current router, final module, auth mode, scope, Origin rule, body limit/raw-body dependency, side effects and consumers. Generate the JSON fixture with stable field-scoped normalization:

Run: `cd backend-node && npm run contract:capture`

Expected: `express-5db1983-contract.json` records baseline SHA, Node version, case IDs and normalized results.

- [ ] **Step 4: Run GREEN and the existing Node contracts**

Run: `cd backend-node && npm test -- tests/contract-harness/baseline.test.ts tests/contracts.test.ts tests/app.test.ts`

Expected: PASS; the manifest covers every extracted route and fixture comparison has no unapproved normalizer.

- [ ] **Step 5: Commit the baseline evidence**

```bash
git add backend-node/contracts backend-node/tests/contract-harness backend-node/scripts/capture-contract-baseline.ts backend-node/package.json backend-node/package-lock.json docs/architecture/node-http-migration-map.md
git commit -m "test: freeze Express HTTP contracts"
```

### Task 2: Add the Nest/Fastify factory and migrate health

**Files:**
- Create: `backend-node/src/app-options.ts`
- Create: `backend-node/src/app.module.ts`
- Create: `backend-node/src/nest-app.ts`
- Create: `backend-node/src/platform/tokens.ts`
- Create: `backend-node/src/platform/http/fastify-platform.ts`
- Create: `backend-node/src/platform/http/http-error.filter.ts`
- Create: `backend-node/src/modules/health/health.service.ts`
- Create: `backend-node/src/modules/health/health.controller.ts`
- Create: `backend-node/src/modules/health/health.module.ts`
- Create: `backend-node/tests/nest/health.test.ts`
- Modify: `backend-node/src/app.ts` (re-export `CreateAppOptions` from `app-options.ts`; Express runtime remains temporarily)
- Modify: `backend-node/package.json`
- Modify: `backend-node/package-lock.json`
- Modify: `backend-node/tsconfig.base.json`

**Interfaces:**
- Consumes: `HealthState`, `DatabaseState`, `defaultAiHealthChecker`, `getDatabaseStatus`.
- Produces:

```ts
export async function createNestApp(
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication>;

export const APP_OPTIONS = Symbol('APP_OPTIONS');
export const AI_HEALTH_CHECKER = Symbol('AI_HEALTH_CHECKER');
export const DATABASE_STATUS_RESOLVER = Symbol('DATABASE_STATUS_RESOLVER');
```

- [ ] **Step 1: Write the failing Fastify health parity test**

Use the real adapter and assert liveness, ready, degraded, database-down, AI-throw and unknown-route cases against the baseline fixture.

```ts
const app = await createNestApp({
  aiHealthChecker: async () => 'healthy',
  databaseStatusResolver: () => 'connected',
});
const response = await app.inject({ method: 'GET', url: '/health/ready' });
expect({ status: response.statusCode, body: response.json() }).toEqual({
  status: 200,
  body: { status: 'ready', degraded: false, dependencies: { database: 'connected', ai: 'healthy' } },
});
await app.close();
```

- [ ] **Step 2: Run RED for the absent Nest factory**

Run: `cd backend-node && npm test -- tests/nest/health.test.ts`

Expected: FAIL with `Cannot find module '../../src/nest-app'`.

- [ ] **Step 3: Install the pinned framework set and implement minimal health**

Install the exact production and test packages:

```bash
cd backend-node
npm install --save-exact @nestjs/common@11.2.1 @nestjs/core@11.2.1 @nestjs/platform-fastify@11.2.1 fastify@5.11.3 @fastify/helmet@13.1.1 @fastify/cors@11.3.0 @fastify/rate-limit@11.2.0 class-validator@0.15.1 class-transformer@0.5.1 reflect-metadata@0.2.2 rxjs@7.8.2
npm install --save-dev --save-exact @nestjs/testing@11.2.1
```

Enable decorators in `tsconfig.base.json`:

```json
{
  "experimentalDecorators": true,
  "emitDecoratorMetadata": true,
  "useDefineForClassFields": false
}
```

Create `createNestApp` with `new FastifyAdapter({ bodyLimit: 32 * 1024, trustProxy: production ? 1 : false, requestIdHeader: false })`, `{ rawBody: true }`, `app.setGlobalPrefix('')`, plugins registered before `app.init()`, and the exact global error filter. Health controllers call one `HealthService`; they do not import Mongoose or fetch directly.

- [ ] **Step 4: Run GREEN, build and compare health contracts**

Run: `cd backend-node && npm test -- tests/nest/health.test.ts tests/health.test.ts tests/contract-harness/baseline.test.ts && npm run build && npm run typecheck`

Expected: PASS. Express remains the default app only during migration; Nest health parity is independently green.

- [ ] **Step 5: Commit the first Nest vertical slice**

```bash
git add backend-node/package.json backend-node/package-lock.json backend-node/tsconfig.base.json backend-node/src/app-options.ts backend-node/src/app.ts backend-node/src/app.module.ts backend-node/src/nest-app.ts backend-node/src/platform backend-node/src/modules/health backend-node/tests/nest/health.test.ts
git commit -m "feat: bootstrap Nest Fastify health"
```

### Task 3: Reproduce the HTTP security and cross-cutting pipeline

**Files:**
- Create: `backend-node/src/platform/http/request-context.ts`
- Create: `backend-node/src/modules/security/security.decorators.ts`
- Create: `backend-node/src/modules/security/security.guard.ts`
- Create: `backend-node/src/modules/security/security.service.ts`
- Create: `backend-node/src/modules/security/audit.service.ts`
- Create: `backend-node/src/modules/security/security.module.ts`
- Create: `backend-node/tests/nest/security.test.ts`
- Modify: `backend-node/src/platform/http/fastify-platform.ts`
- Modify: `backend-node/src/app.module.ts`
- Modify: `backend-node/src/audit.ts` (remove only Express types; retain sink and chain behavior)
- Modify: `backend-node/src/auth.ts` (extract verifier/principal primitives; Express middleware remains until cutover)

**Interfaces:**
- Consumes: `AuthPrincipal`, `OidcTokenVerifier`, `AuditSink`, `CreateAppOptions`.
- Produces:

```ts
export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  origin?: string;
  principal?: AuthPrincipal;
}

export const PublicRoute = () => SetMetadata('publicRoute', true);
export const RequiredScopes = (...scopes: string[]) => SetMetadata('requiredScopes', scopes);
```

- [ ] **Step 1: Write failing differential security tests**

Cover missing/invalid static bearer, OIDC verifier failure, task/calendar scopes, auth-before-Origin ordering, Origin audit failure, CORS preflight, Helmet headers, `32kb` body rejection, valid/invalid request IDs, production error redaction, exact rate-limit headers/body and one trusted proxy hop. Add an explicit CSRF applicability test/documentation assertion: browser clients use bearer headers with `credentials: 'omit'`, no ambient session cookie authenticates unsafe requests, no CSRF token is part of the current contract, and trusted Origin/CORS enforcement remains unchanged.

```ts
expect(second.statusCode).toBe(429);
expect(second.headers).toMatchObject({
  'ratelimit-policy': '1;w=60',
  'ratelimit-limit': '1',
  'ratelimit-remaining': '0',
  'retry-after': '60',
});
expect(second.body).toBe('Too many requests, please try again later.');
```

- [ ] **Step 2: Run RED and identify the first real parity difference**

Run: `cd backend-node && npm test -- tests/nest/security.test.ts`

Expected: FAIL because no global security guard/request context/rate-limit compatibility exists. Record the first mismatch in `docs/architecture/node-http-migration-map.md` before implementing it.

- [ ] **Step 3: Implement the single-owner pipeline**

Register `@fastify/helmet`, `@fastify/cors` and `@fastify/rate-limit` once in `fastify-platform.ts`. Configure rate limit with `timeWindow: 60_000`, `max: options.rateLimitLimit ?? 120`, `enableDraftSpec: true`, an `onSend` compatibility hook for `RateLimit-Policy`, and the exact Express text response. Do not enable Nest CORS in addition to the plugin.

Implement one global `SecurityGuard` that executes in this order:

```ts
if (metadata.publicRoute || request.method === 'OPTIONS') return true;
const principal = await security.authenticate(request.headers.authorization);
context.principal = principal;
await security.requireTrustedOrigin(context);
await security.requireScopes(principal, requiredScopesFor(context));
return true;
```

Audit every rejection through `AuditService.recordOrThrow`; map audit failure to `{ error: 'Security audit is unavailable' }` with status `503`. Preserve the existing token hashing, OIDC JOSE settings, audit event fields and production config gates.

- [ ] **Step 4: Run GREEN and focused legacy security suites**

Run: `cd backend-node && npm test -- tests/nest/security.test.ts tests/app.test.ts tests/auth.test.ts tests/audit.test.ts tests/config.test.ts`

Expected: PASS with exact security, CORS, rate-limit, request-ID and audit parity.

- [ ] **Step 5: Commit the security substrate**

```bash
git add backend-node/src/platform/http backend-node/src/modules/security backend-node/src/app.module.ts backend-node/src/audit.ts backend-node/src/auth.ts backend-node/tests/nest/security.test.ts docs/architecture/node-http-migration-map.md
git commit -m "feat: preserve Node HTTP security on Fastify"
```

### Task 4: Migrate task queries without duplicating business logic

**Files:**
- Create: `backend-node/src/application/tasks/task-query.service.ts`
- Create: `backend-node/src/modules/tasks/task-query.dto.ts`
- Create: `backend-node/src/modules/tasks/task-query.controller.ts`
- Create: `backend-node/src/modules/tasks/tasks.module.ts`
- Create: `backend-node/tests/nest/task-queries.test.ts`
- Modify: `backend-node/src/app.module.ts`
- Modify: `backend-node/src/routes/tasks.ts` (delegate read handlers to `TaskQueryService` during the short migration window)
- Modify: `backend-node/src/repositories/mongooseTaskRepository.ts`
- Modify: `docs/architecture/node-http-migration-map.md`

**Interfaces:**
- Consumes: `TaskRepository`, `AuthPrincipal`, lifecycle/cursor domain types.
- Produces:

```ts
export interface TaskListQuery {
  limit: number;
  cursor?: string;
  lifecycle: TaskLifecycleFilter;
}

export interface TaskListResult {
  tasks: StoredTask[];
  nextCursor?: string;
}

export class TaskQueryService {
  getOwned(principal: AuthPrincipal, id: string): Promise<StoredTask>;
  listOwned(principal: AuthPrincipal, query: TaskListQuery): Promise<TaskListResult>;
  listDelegated(principal: AuthPrincipal, query: Pick<TaskListQuery, 'limit' | 'lifecycle'>): Promise<StoredTask[]>;
}
```

- [ ] **Step 1: Write failing query parity tests**

Cover `GET /tasks/delegated`, `GET /tasks/:id` and `GET /tasks`, including ownership hiding, lifecycle filters, invalid Mongo IDs, pagination cursor encoding, repeated/invalid cursor rejection, default/max limit, `ETag`, `X-Next-Cursor` and `Link`.

```ts
const page = await inject(app, 'GET', '/tasks?limit=1', bearer);
expect(page.status).toBe(200);
expect(page.headers['x-next-cursor']).toMatch(/^[A-Za-z0-9_-]+$/);
expect(page.headers.link).toContain('rel="next"');
```

- [ ] **Step 2: Run RED against missing controllers/services**

Run: `cd backend-node && npm test -- tests/nest/task-queries.test.ts`

Expected: FAIL with Nest `404` for `/tasks` while the Express characterization remains green.

- [ ] **Step 3: Extract one query implementation and add thin controllers**

Move cursor parsing/encoding, scope construction and repository coordination into `TaskQueryService`. Keep DTO validation transport-only. Inject `TaskRepository` through a symbol token; do not inject `Model` into controllers. During this task, Express read handlers call the same `TaskQueryService` instead of keeping a second copy.

- [ ] **Step 4: Run GREEN and query-focused suites**

Run: `cd backend-node && npm test -- tests/nest/task-queries.test.ts tests/tasks.test.ts tests/delegation.test.ts tests/contracts.test.ts`

Expected: PASS; the migration map marks the three query routes `candidate-green` and identifies one application owner.

- [ ] **Step 5: Commit task queries**

```bash
git add backend-node/src/application/tasks backend-node/src/modules/tasks backend-node/src/app.module.ts backend-node/src/routes/tasks.ts backend-node/src/repositories/mongooseTaskRepository.ts backend-node/tests/nest/task-queries.test.ts docs/architecture/node-http-migration-map.md
git commit -m "feat: migrate task queries to Nest"
```

### Task 5: Migrate task commands, validation and optimistic concurrency

**Files:**
- Create: `backend-node/src/application/tasks/task-command.service.ts`
- Create: `backend-node/src/application/tasks/task-errors.ts`
- Create: `backend-node/src/modules/tasks/task-command.dto.ts`
- Create: `backend-node/src/modules/tasks/task-command.controller.ts`
- Create: `backend-node/src/modules/tasks/task-validation.pipe.ts`
- Create: `backend-node/tests/nest/task-commands.test.ts`
- Modify: `backend-node/src/modules/tasks/tasks.module.ts`
- Modify: `backend-node/src/routes/tasks.ts` (delegate then remove migrated write handlers)
- Modify: `backend-node/src/application/createTask.ts`
- Modify: `backend-node/src/application/calendar.ts`
- Modify: `docs/architecture/node-http-migration-map.md`

**Interfaces:**
- Consumes: `TaskRepository`, `CalendarApplicationService`, task domain types, `AuthPrincipal`.
- Produces:

```ts
export interface TaskWriteResult {
  task: StoredTask;
  status: 200 | 201;
  idempotencyReplayed?: true;
}

export class TaskCommandService {
  create(principal: AuthPrincipal, payload: TaskPayload, idempotencyKey?: string): Promise<TaskWriteResult>;
  update(principal: AuthPrincipal, id: string, revision: number, patch: Partial<TaskPayload>): Promise<StoredTask>;
  transitionLifecycle(principal: AuthPrincipal, id: string, revision: number, action: TaskLifecycleAction): Promise<StoredTask>;
  updateSchedule(principal: AuthPrincipal, id: string, revision: number, schedule: TaskSchedule | null): Promise<StoredTask>;
  updateDelegation(principal: AuthPrincipal, id: string, revision: number, input: TaskDelegationAssignment | null): Promise<StoredTask>;
  transitionDelegation(principal: AuthPrincipal, id: string, revision: number, status: TaskDelegationStatus): Promise<StoredTask>;
  delete(principal: AuthPrincipal, id: string, revision: number): Promise<StoredTask>;
}
```

- [ ] **Step 1: Write failing command parity tests**

Cover create, replay, concurrent create, payload-key conflict, deleted replay result, update, lifecycle, schedule, delegation, delete, tenant isolation, strict `If-Match`, weak/malformed/unsafe revisions, unknown fields, string bounds and exact validation detail ordering.

```ts
const weak = await inject(app, 'PUT', `/tasks/${id}`, {
  ...bearer, 'if-match': 'W/"0"',
}, { urgent: true });
expect(weak).toMatchObject({ status: 400, json: { error: 'Invalid If-Match header' } });
```

- [ ] **Step 2: Run RED and verify the failure is an absent Nest command route**

Run: `cd backend-node && npm test -- tests/nest/task-commands.test.ts`

Expected: FAIL with `404` or the first exact validation mismatch, not with missing Mongo setup.

- [ ] **Step 3: Implement commands and exact validation mapping**

Use concrete DTO classes with `class-validator`, `whitelist: true`, `forbidNonWhitelisted: true`, `transform: false` and a custom exception factory that emits the existing `{ error, details }` shape and order. Keep `If-Match` and idempotency parsing in explicit transport helpers because their wire grammar is stricter than generic numeric pipes. Move application coordination from Express handlers to `TaskCommandService`; both temporary adapters call it until the Express route is removed.

- [ ] **Step 4: Run GREEN, task coverage and BDD**

Run: `cd backend-node && npm test -- tests/nest/task-commands.test.ts tests/tasks.test.ts tests/delegation.test.ts tests/calendar.test.ts && npm run test:bdd`

Expected: PASS; all task routes in the migration map are `candidate-green` with one application implementation.

- [ ] **Step 5: Commit task commands**

```bash
git add backend-node/src/application/tasks backend-node/src/application/createTask.ts backend-node/src/application/calendar.ts backend-node/src/modules/tasks backend-node/src/routes/tasks.ts backend-node/tests/nest/task-commands.test.ts docs/architecture/node-http-migration-map.md
git commit -m "feat: migrate task commands to Nest"
```

### Task 6: Migrate the public Calendar API

**Files:**
- Create: `backend-node/src/modules/calendar/calendar.dto.ts`
- Create: `backend-node/src/modules/calendar/calendar-query.controller.ts`
- Create: `backend-node/src/modules/calendar/calendar-command.controller.ts`
- Create: `backend-node/src/modules/calendar/calendar.module.ts`
- Create: `backend-node/tests/nest/calendar-public.test.ts`
- Modify: `backend-node/src/application/calendar.ts`
- Modify: `backend-node/src/routes/calendar.ts` (delegate then remove migrated handlers)
- Modify: `backend-node/src/app.module.ts`
- Modify: `docs/architecture/node-http-migration-map.md`

**Interfaces:**
- Consumes: `CalendarApplicationService`, `GoogleCalendarService`, `AuthPrincipal`, Mongoose Calendar models.
- Produces controllers for:

```text
GET  /calendar/status
POST /calendar/sync-requests
GET  /calendar/events
POST /calendar/bindings/preview
POST /calendar/bindings
POST /calendar/imports
GET  /calendar/conflicts
GET  /calendar/deleted-bindings
POST /calendar/deleted-bindings/:id/resolve
POST /calendar/conflicts/:id/resolve
```

- [ ] **Step 1: Write failing public Calendar parity tests**

Cover disconnected/connected status, scope rejection, bounded candidate listing, preview/link direction, selected-only import, import replay, conflict listing/resolution, deletion decisions, `If-Match`, idempotency keys and provider failure mapping.

```ts
const response = await inject(app, 'POST', '/calendar/bindings', {
  ...bearer, 'idempotency-key': 'calendar-link-1',
}, { taskId, providerEventId, direction: 'eisenhower_to_google' });
expect(response.status).toBe(201);
expect(response.json).toMatchObject({ taskId, providerEventId });
```

- [ ] **Step 2: Run RED for missing Nest Calendar routes**

Run: `cd backend-node && npm test -- tests/nest/calendar-public.test.ts`

Expected: FAIL with `404` on the first `/calendar` case.

- [ ] **Step 3: Implement thin Calendar controllers**

Inject the existing `CalendarApplicationService` and `GoogleCalendarService` behind tokens. Keep Mongo transactions, binding uniqueness and outbox emission in application/infrastructure code. DTOs validate only the wire shape. Controllers derive `{ tenantId, ownerId }` from the authenticated principal and never accept those values from request bodies.

- [ ] **Step 4: Run GREEN and existing Calendar/provider suites**

Run: `cd backend-node && npm test -- tests/nest/calendar-public.test.ts tests/calendar.test.ts tests/googleCalendarProvider.test.ts`

Expected: PASS with the ten public Calendar routes marked `candidate-green`.

- [ ] **Step 5: Commit the public Calendar slice**

```bash
git add backend-node/src/modules/calendar backend-node/src/application/calendar.ts backend-node/src/routes/calendar.ts backend-node/src/app.module.ts backend-node/tests/nest/calendar-public.test.ts docs/architecture/node-http-migration-map.md
git commit -m "feat: migrate public Calendar routes to Nest"
```

### Task 7: Migrate Google OAuth and provider adapters

**Files:**
- Create: `backend-node/src/modules/google/google-oauth.dto.ts`
- Create: `backend-node/src/modules/google/google-oauth.controller.ts`
- Create: `backend-node/src/modules/google/google-provider.controller.ts`
- Create: `backend-node/src/modules/google/google.module.ts`
- Create: `backend-node/tests/nest/google-integration.test.ts`
- Modify: `backend-node/src/application/googleOAuth.ts`
- Modify: `backend-node/src/application/googleCalendar.ts`
- Modify: `backend-node/src/routes/googleOAuth.ts` (delegate then remove)
- Modify: `backend-node/src/routes/googleCalendarProvider.ts` (delegate then remove)
- Modify: `backend-node/src/app.module.ts`
- Modify: `docs/architecture/node-http-migration-map.md`

**Interfaces:**
- Consumes: `GoogleOAuthService`, `GoogleOAuthPort`, `GoogleCalendarService`, `GoogleCalendarPort`.
- Produces:

```text
GET  /calendar/oauth/callback                public, state-bound
POST /calendar/oauth/start                   calendar:write
POST /calendar/oauth/disconnect              calendar:write
POST /internal/calendar/provider/outbound    internal HMAC
POST /internal/calendar/provider/changes     internal HMAC
POST /internal/calendar/provider/watch       internal HMAC
```

- [ ] **Step 1: Write failing OAuth/provider parity tests**

Cover state expiry/single-use, safe return origin/path, callback redirect status/location, callback without state/code, token exchange failures, encrypted credentials, disconnect, immediate watch registration, provider ETag forwarding and sanitized provider errors.

```ts
const callback = await app.inject({
  method: 'GET',
  url: `/calendar/oauth/callback?state=${state}&code=google-code`,
});
expect(callback.statusCode).toBe(302);
expect(callback.headers.location).toBe('https://tasks.example.com/settings?tab=calendar');
```

- [ ] **Step 2: Run RED for missing Nest OAuth/provider routes**

Run: `cd backend-node && npm test -- tests/nest/google-integration.test.ts`

Expected: FAIL with `404` on `/calendar/oauth/start` or the first redirect mismatch.

- [ ] **Step 3: Implement the Google module without provider-type leakage**

Use symbol-token providers for `GoogleOAuthPort` and `GoogleCalendarPort`. Keep HTTP request construction, retries, timeouts, auth headers and provider payload mapping inside the existing adapters. Mark only the callback route public; start/disconnect use Calendar scope metadata. Provider controllers are protected by the internal HMAC guard introduced in Task 8; until then the Nest test module injects a test guard override rather than bypassing application services.

- [ ] **Step 4: Run GREEN and all Google tests**

Run: `cd backend-node && npm test -- tests/nest/google-integration.test.ts tests/googleOAuth.test.ts tests/googleCalendarProvider.test.ts`

Expected: PASS with exact redirects, errors and provider calls.

- [ ] **Step 5: Commit Google integration**

```bash
git add backend-node/src/modules/google backend-node/src/application/googleOAuth.ts backend-node/src/application/googleCalendar.ts backend-node/src/routes/googleOAuth.ts backend-node/src/routes/googleCalendarProvider.ts backend-node/src/app.module.ts backend-node/tests/nest/google-integration.test.ts docs/architecture/node-http-migration-map.md
git commit -m "feat: migrate Google integration to Nest"
```

### Task 8: Migrate internal Calendar HMAC, outbox and recovery routes

**Files:**
- Create: `backend-node/src/modules/calendar-internal/internal-hmac.service.ts`
- Create: `backend-node/src/modules/calendar-internal/internal-hmac.guard.ts`
- Create: `backend-node/src/modules/calendar-internal/calendar-inbound.controller.ts`
- Create: `backend-node/src/modules/calendar-internal/calendar-outbox.controller.ts`
- Create: `backend-node/src/modules/calendar-internal/calendar-operations.controller.ts`
- Create: `backend-node/src/modules/calendar-internal/calendar-internal.module.ts`
- Create: `backend-node/tests/nest/calendar-internal.test.ts`
- Modify: `backend-node/src/routes/calendarInternal.ts` (delegate then remove)
- Modify: `backend-node/src/app.module.ts`
- Modify: `backend-node/src/modules/google/google.module.ts`
- Modify: `docs/architecture/node-http-migration-map.md`

**Interfaces:**
- Consumes: exact raw body, request ID, `CALENDAR_INTERNAL_HMAC_KEY`, Calendar application service/models.
- Produces controllers for all baseline aliases and operations:

```text
POST /internal/calendar/inbound
POST /internal/calendar/sync/apply
POST /internal/calendar/sync/apply-batch
POST /internal/calendar/sync/reset
POST /internal/calendar/request
POST /internal/calendar/outbound/claim
POST /internal/calendar/outbox/claim
POST /internal/calendar/outbound/result
POST /internal/calendar/outbox/acknowledge
POST /internal/calendar/notifications/validate
POST /internal/calendar/watch/renew
POST /internal/calendar/reconciliation/claim
POST /internal/calendar/status
```

- [ ] **Step 1: Write failing raw-body/HMAC and durability parity tests**

Cover canonical path and alias signatures, exact raw JSON bytes, timestamp window, malformed/wrong signature, request-ID binding, durable replay rejection, batch bounds, lease claim/reclaim, acknowledgement, dead-letter, watch renewal, notification validation, reconciliation and status.

```ts
const raw = Buffer.from('{"events":[{"id":"one"}]}');
const signature = signInternal({ method: 'POST', path, requestId, timestamp, raw });
const response = await app.inject({
  method: 'POST', url: path, payload: raw,
  headers: signedHeaders(signature, requestId, timestamp, 'application/json'),
});
expect(response.statusCode).toBe(202);
```

- [ ] **Step 2: Run RED and verify raw body is the first missing contract**

Run: `cd backend-node && npm test -- tests/nest/calendar-internal.test.ts`

Expected: FAIL because internal routes or the HMAC guard are absent. If the failure is `rawBody` undefined, retain it as the expected RED before implementing the guard.

- [ ] **Step 3: Implement one HMAC guard and focused controllers**

Use Nest `RawBodyRequest<FastifyRequest>` only inside the HTTP guard/controller edge. Pass `Buffer`, method, canonical route path, timestamp and request ID into a framework-neutral `InternalHmacService`. Preserve `createHmac`, `timingSafeEqual`, replay receipt indexes and error mapping. Both alias paths call the same application method; no operation is copied.

- [ ] **Step 4: Run GREEN plus n8n contracts**

Run: `cd backend-node && npm test -- tests/nest/calendar-internal.test.ts tests/calendar.test.ts tests/googleCalendarProvider.test.ts && cd .. && make test-n8n`

Expected: PASS; every internal route and alias is `candidate-green`, and n8n raw JSON signing contracts remain green.

- [ ] **Step 5: Commit internal Calendar**

```bash
git add backend-node/src/modules/calendar-internal backend-node/src/routes/calendarInternal.ts backend-node/src/app.module.ts backend-node/src/modules/google backend-node/tests/nest/calendar-internal.test.ts docs/architecture/node-http-migration-map.md
git commit -m "feat: migrate internal Calendar routes to Nest"
```

### Task 9: Cut over Node tests, BDD and runtime; remove Express completely

**Files:**
- Create: `backend-node/src/platform/http/http-test-client.ts`
- Create: `backend-node/tests/framework-migration.test.ts`
- Modify: `backend-node/src/app.ts`
- Modify: `backend-node/src/server.ts`
- Modify: `backend-node/tests/helpers/testServer.ts`
- Modify: `backend-node/tests/**/*.test.ts`
- Modify: `backend-node/features/support/world.ts`
- Modify: `backend-node/features/step_definitions/*.ts`
- Modify: `backend-node/scripts/e2e-server.ts`
- Modify: `backend-node/package.json`
- Modify: `backend-node/package-lock.json`
- Modify: `backend-node/tsconfig*.json`
- Delete: `backend-node/src/nest-app.ts`
- Delete: `backend-node/src/routes/health.ts`
- Delete: `backend-node/src/routes/tasks.ts`
- Delete: `backend-node/src/routes/calendar.ts`
- Delete: `backend-node/src/routes/googleOAuth.ts`
- Delete: `backend-node/src/routes/googleCalendarProvider.ts`
- Delete: `backend-node/src/routes/calendarInternal.ts`

**Interfaces:**
- Consumes: all green Nest modules from Tasks 2-8.
- Produces:

```ts
export async function createApp(
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication>;

export interface TestResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: unknown;
  text: string;
}
```

- [ ] **Step 1: Write the failing framework-removal contract**

Assert that final manifests and source contain no forbidden dependency/import, `src/app.ts` uses `FastifyAdapter`, every route map entry is `nest-final`, and exactly one route owner exists.

```ts
for (const forbidden of [
  'express', 'express-validator', 'express-rate-limit', '@types/express', '@types/cors', 'supertest', '@types/supertest',
]) expect(allDeclaredDependencies).not.toContain(forbidden);
expect(sourceImports).not.toMatch(/from ['"](?:express|cors|helmet)['"]/);
```

- [ ] **Step 2: Run RED and confirm it lists the remaining Express artifacts**

Run: `cd backend-node && npm test -- tests/framework-migration.test.ts`

Expected: FAIL with a concrete list of Express packages, route files and test imports.

- [ ] **Step 3: Make Nest the only factory and migrate the test transport**

Replace Supertest with a small `app.inject()` facade that preserves test readability without emulating Express production behavior. Make all `beforeEach` hooks await `createApp()` and all `afterEach/afterAll` hooks close applications. In Cucumber, replace the test-only Express router with an OIDC verifier override that returns principals derived from scenario tokens. Update `startTestServer()` to call `await app.listen({ host, port })` and `await app.close()`.

Update `server.ts`:

```ts
const app = await createApp();
await connectToDatabase(config.mongodbUri);
await app.listen({ port: config.port, host: '0.0.0.0' });
// SIGINT/SIGTERM: await app.close(); await disconnectFromDatabase();
```

Delete all Express routers after their Nest owners are green. Remove `express`, `express-validator`, `express-rate-limit`, `cors`, Express `helmet`, their types and Supertest packages. Keep only `@fastify/helmet` and `@fastify/cors` as the security/CORS owners.

- [ ] **Step 4: Run the complete Node/client/BDD/web contract surface**

Run: `cd backend-node && npm run build && npm run typecheck && npm run test:coverage && npm run test:bdd && cd .. && make test-api-client && make test-n8n && cd web && npm run build && npm run test:integration`

Expected: PASS; Node retains 100% statement/branch/function/line coverage, 21 BDD scenarios/149 steps pass, clients and real web integration require no API changes.

- [ ] **Step 5: Commit the single Node runtime**

```bash
git add -A backend-node packages/api-client web docs/architecture/node-http-migration-map.md
git commit -m "refactor: cut over backend-node to Nest Fastify"
```

### Task 10: Freeze FastAPI OpenAPI, import and middleware behavior

**Files:**
- Create: `backend-ai/tests/fixtures/main-openapi-baseline.json`
- Create: `backend-ai/tests/test_main_composition_contract.py`
- Create: `backend-ai/scripts/capture_main_openapi.py`
- Modify: `backend-ai/pytest.ini` only if the new fixture path requires test discovery configuration

**Interfaces:**
- Consumes: `app.main.create_app`, current DI parameters and FastAPI `app.openapi()`.
- Produces normalized OpenAPI and behavior fixtures keyed by endpoint/method/schema/security visibility.

- [ ] **Step 1: Write the failing FastAPI fixture and modularity tests**

Capture exact OpenAPI paths/methods/request refs/response refs and test lightweight imports. Add a structural test that requires the future factory and routers while forbidding route decorators in the final compatibility facade.

```python
def test_main_is_a_compatibility_facade():
  source = Path(app_main.__file__).read_text(encoding="utf-8")
  assert "@app." not in source
  assert "from .http.factory import create_app" in source
```

- [ ] **Step 2: Run RED for the missing fixture and still-large facade**

Run: `cd backend-ai && ./venv/bin/python -m pytest -q --no-cov tests/test_main_composition_contract.py`

Expected: FAIL because the fixture is absent and `app/main.py` still contains route decorators. Split fixture capture from the structural assertion so the fixture can be generated while the structural RED remains visible.

- [ ] **Step 3: Capture the exact baseline without changing application code**

The capture script creates settings with temporary paths and deterministic test services, calls `create_app`, removes only generated OpenAPI description ordering noise, and writes `main-openapi-baseline.json`. It must also record:

```python
{
  "factory_parameters": [
    "settings", "store", "ai_service", "rag_service", "token_verifier",
    "metrics_registry", "audit_sink", "memory_runtime",
  ],
  "public_imports": ["app.create_app", "app.main.create_app", "main.app"],
}
```

Run: `cd backend-ai && ./venv/bin/python scripts/capture_main_openapi.py`

- [ ] **Step 4: Verify the characterization half is green and structural RED remains**

Run: `cd backend-ai && ./venv/bin/python -m pytest -q --no-cov tests/test_main_composition_contract.py -k 'openapi or imports or middleware'`

Expected: PASS for captured behavior. Running the full file still fails only on `test_main_is_a_compatibility_facade`.

- [ ] **Step 5: Commit FastAPI baseline evidence**

```bash
git add backend-ai/tests/fixtures/main-openapi-baseline.json backend-ai/tests/test_main_composition_contract.py backend-ai/scripts/capture_main_openapi.py backend-ai/pytest.ini
git commit -m "test: freeze FastAPI boundary contracts"
```

### Task 11: Extract FastAPI schemas and lazy dependency composition

**Files:**
- Create: `backend-ai/app/http/__init__.py`
- Create: `backend-ai/app/http/schemas.py`
- Create: `backend-ai/app/http/composition.py`
- Create: `backend-ai/tests/test_http_composition.py`
- Modify: `backend-ai/app/main.py`
- Modify: `backend-ai/tests/test_main_composition_contract.py`

**Interfaces:**
- Consumes: `Settings`, `TrainingStore`, `QuadrantAIService`, verifier, metrics, audit, queue and optional AI/RAG runtime ports already accepted by `create_app`.
- Produces:

```python
@dataclass(frozen=True)
class AppDependencies:
    settings: Settings
    store: TrainingStore
    ai_service: QuadrantAIService
    rag_service: object | None
    token_verifier: TokenVerifier
    internal_verifier: ServiceTokenVerifier | None
    webhook_verifier: WebhookReplayVerifier | None
    job_queue: SqliteJobQueue | None
    metrics_registry: MetricsRegistry
    audit_sink: AuditSink
    memory_runtime: object | None
    response_canary_router: ResponseCanaryRouter | None

def build_dependencies(
    settings: Settings | None = None,
    store: TrainingStore | None = None,
    ai_service: QuadrantAIService | None = None,
    rag_service: object | None = None,
    token_verifier: TokenVerifier | None = None,
    metrics_registry: MetricsRegistry | None = None,
    audit_sink: AuditSink | None = None,
    memory_runtime: object | None = None,
) -> AppDependencies: ...
```

- [ ] **Step 1: Write failing schema and composition tests**

Assert that schema classes preserve Pydantic field aliases/defaults/constraints and JSON Schema output, `build_dependencies` keeps the public factory parameter contract, injected values win over defaults, required directories are initialized once, and importing the lightweight boundary does not import model/vector/provider implementations.

```python
def test_build_dependencies_prefers_injected_services(tmp_path):
    deps = build_dependencies(settings=settings_for(tmp_path), store=store, ai_service=ai)
    assert deps.store is store
    assert deps.ai_service is ai
```

- [ ] **Step 2: Run RED for the missing focused modules**

Run: `cd backend-ai && ./venv/bin/python -m pytest -q --no-cov tests/test_http_composition.py`

Expected: FAIL on `ModuleNotFoundError: app.http.composition` before any model is loaded.

- [ ] **Step 3: Move schemas and construct dependencies lazily**

Move request/response models and reusable validation constants from `app/main.py` to `app/http/schemas.py` without renaming schemas or changing module-visible re-exports. Move default service construction to `build_dependencies`; keep provider imports inside the branch that constructs that provider. Do not move domain or Qdrant payload types into `app/http`. Re-export public schema names from `app.main` during the refactor so existing imports remain valid.

- [ ] **Step 4: Run GREEN and compare the frozen OpenAPI document**

Run: `cd backend-ai && ./venv/bin/python -m pytest -q --no-cov tests/test_http_composition.py tests/test_main_composition_contract.py -k 'schemas or dependencies or openapi or imports'`

Expected: PASS; normalized OpenAPI equals the Task 10 fixture and lightweight imports do not load heavy providers.

- [ ] **Step 5: Commit schemas and composition**

```bash
git add backend-ai/app/http backend-ai/app/main.py backend-ai/tests/test_http_composition.py backend-ai/tests/test_main_composition_contract.py
git commit -m "refactor: extract FastAPI composition"
```

### Task 12: Extract FastAPI middleware, security, audit and error mapping

**Files:**
- Create: `backend-ai/app/http/middleware.py`
- Create: `backend-ai/app/http/errors.py`
- Create: `backend-ai/tests/test_http_middleware.py`
- Modify: `backend-ai/app/main.py`
- Modify: `backend-ai/app/http/composition.py`
- Modify: `backend-ai/tests/test_main_composition_contract.py`

**Interfaces:**
- Consumes: `FastAPI`, `AppDependencies`, request context, token/internal/webhook verifiers, metrics and audit ports.
- Produces:

```python
def register_middleware(app: FastAPI, deps: AppDependencies) -> None: ...
def register_exception_handlers(app: FastAPI, deps: AppDependencies) -> None: ...
```

- [ ] **Step 1: Characterize effective middleware order and failure semantics**

Write tests for generated/preserved request ID, authentication before authorization, trusted origin, lightweight and knowledge-only roles, ACL and citation visibility, audit success/failure, metrics labels, sensitive-error redaction and exception bodies. Record observed call order from an instrumented verifier/audit sink; do not infer it from Starlette decorator definition order.

```python
assert calls == [
    "request-context", "authenticate", "authorize", "handler", "audit", "metrics"
]
assert response.headers["x-request-id"] == request_id
```

- [ ] **Step 2: Run RED for missing registrars**

Run: `cd backend-ai && ./venv/bin/python -m pytest -q --no-cov tests/test_http_middleware.py`

Expected: FAIL because `register_middleware` and `register_exception_handlers` do not exist.

- [ ] **Step 3: Move cross-cutting HTTP behavior to one owner**

Register middleware in the order required to reproduce the characterized effective call order. Keep bearer/internal/webhook verification and audit primitives behind existing ports. Preserve fail-closed audit behavior, exact status/error/security headers, request-ID propagation, metrics names/labels, role restrictions and public health behavior. Move only HTTP exception translation to `errors.py`; application/provider exceptions remain framework-neutral.

- [ ] **Step 4: Run GREEN plus security/audit/metrics suites**

Run: `cd backend-ai && ./venv/bin/python -m pytest -q --no-cov tests/test_http_middleware.py tests/test_auth.py tests/test_security_controls.py tests/test_audit.py tests/test_metrics.py tests/test_main_composition_contract.py`

Expected: PASS with exact response and call-order parity.

- [ ] **Step 5: Commit HTTP cross-cutting behavior**

```bash
git add backend-ai/app/http backend-ai/app/main.py backend-ai/tests/test_http_middleware.py backend-ai/tests/test_main_composition_contract.py
git commit -m "refactor: isolate FastAPI HTTP middleware"
```

### Task 13: Extract health, analysis, knowledge and OCR routers

**Files:**
- Create: `backend-ai/app/http/health.py`
- Create: `backend-ai/app/http/analysis.py`
- Create: `backend-ai/app/http/knowledge.py`
- Create: `backend-ai/app/http/ocr.py`
- Create: `backend-ai/tests/test_http_public_routers.py`
- Modify: `backend-ai/app/main.py`
- Modify: `backend-ai/tests/test_main_composition_contract.py`

**Interfaces:**
- Each router module produces one transport-only factory:

```python
def create_health_router(deps: AppDependencies) -> APIRouter: ...
def create_analysis_router(deps: AppDependencies) -> APIRouter: ...
def create_knowledge_router(deps: AppDependencies) -> APIRouter: ...
def create_ocr_router(deps: AppDependencies) -> APIRouter: ...
```

- [ ] **Step 1: Write failing router ownership tests**

Cover liveness/readiness, synchronous analysis/classification/fallback, RAG ACL/citations, knowledge role gates and OCR size/dimension/pixel rejection. Assert route paths, methods, response models, security metadata and operation IDs match the baseline and each path/method has one owner.

- [ ] **Step 2: Run RED for missing router factories**

Run: `cd backend-ai && ./venv/bin/python -m pytest -q --no-cov tests/test_http_public_routers.py`

Expected: FAIL on the first missing router import.

- [ ] **Step 3: Move route orchestration without moving application policy**

Move decorators and request/response mapping into the four router modules. Routers call the existing AI/RAG/OCR/application services and do not construct providers, access Qdrant directly or copy ACL/fallback logic. `app.main` includes each router once and continues re-exporting public compatibility names.

- [ ] **Step 4: Run GREEN and focused behavior/OpenAPI suites**

Run: `cd backend-ai && ./venv/bin/python -m pytest -q --no-cov tests/test_http_public_routers.py tests/test_api.py tests/test_auth.py tests/test_security_controls.py tests/test_rag_application.py tests/test_rag_bootstrap.py tests/test_document_extraction_application.py tests/test_main_composition_contract.py`

Expected: PASS; normalized OpenAPI stays byte-equivalent to the Task 10 fixture.

- [ ] **Step 5: Commit public routers**

```bash
git add backend-ai/app/http backend-ai/app/main.py backend-ai/tests/test_http_public_routers.py backend-ai/tests/test_main_composition_contract.py
git commit -m "refactor: extract FastAPI public routers"
```

### Task 14: Extract internal, training and operator routers; make main a thin facade

**Files:**
- Create: `backend-ai/app/http/internal.py`
- Create: `backend-ai/app/http/training.py`
- Create: `backend-ai/app/http/operator.py`
- Create: `backend-ai/app/http/factory.py`
- Create: `backend-ai/tests/test_http_private_routers.py`
- Modify: `backend-ai/app/main.py`
- Modify: `backend-ai/app/__init__.py`
- Modify: `backend-ai/app/knowledge_runtime.py`
- Modify: `backend-ai/main.py`
- Modify: `backend-ai/tests/test_main_composition_contract.py`

**Interfaces:**
- Produces the canonical factory with the unchanged public signature:

```python
def create_app(
    settings: Settings | None = None,
    store: TrainingStore | None = None,
    ai_service: QuadrantAIService | None = None,
    rag_service: object | None = None,
    token_verifier: TokenVerifier | None = None,
    metrics_registry: MetricsRegistry | None = None,
    audit_sink: AuditSink | None = None,
    memory_runtime: object | None = None,
) -> FastAPI: ...
```

- [ ] **Step 1: Write failing private-router and facade tests**

Cover service-token/HMAC/webhook replay, training ingestion and feedback, job queue transitions, operator/canary controls, role-specific route visibility and import-safe boundary/knowledge factories. Assert `app/main.py` contains no route decorators, middleware bodies, provider construction or application policy.

- [ ] **Step 2: Run RED for the missing factories and thick facade**

Run: `cd backend-ai && ./venv/bin/python -m pytest -q --no-cov tests/test_http_private_routers.py tests/test_main_composition_contract.py`

Expected: FAIL because private router/factory modules are absent and the facade structural assertion remains red.

- [ ] **Step 3: Move remaining routes and establish one canonical factory**

Create focused router factories in `internal.py`, `training.py` and `operator.py`; include them once in `http/factory.py`. Make `app/main.py` a compatibility facade that imports/re-exports `create_app` and public schemas only. Update `app.knowledge_runtime`, `app.__init__` and root `main.py` to import the canonical factory without cycles while preserving:

```text
app.create_app
app.main.create_app
main.app
app.api_boundary:from_environment
app.knowledge_runtime:from_environment
```

- [ ] **Step 4: Run GREEN and the complete FastAPI boundary suite**

Run: `cd backend-ai && ./venv/bin/python -m pytest -q --no-cov tests/test_http_private_routers.py tests/test_main_composition_contract.py tests/test_api.py tests/test_auth.py tests/test_jobs_webhooks.py tests/test_store.py tests/test_provider_state.py tests/test_runtime_roles.py tests/test_api_boundary.py`

Expected: PASS; the full structural assertion is green, public imports work in fresh subprocesses, and OpenAPI equals the baseline.

- [ ] **Step 5: Commit the thin factory/facade**

```bash
git add backend-ai/app/http backend-ai/app/main.py backend-ai/app/__init__.py backend-ai/app/knowledge_runtime.py backend-ai/main.py backend-ai/tests
git commit -m "refactor: modularize FastAPI boundary"
```

### Task 15: Update consumers and documentation; run cross-boundary verification

**Files:**
- Create: `scripts/verify-framework-boundaries.mjs`
- Create: `tests/test_framework_boundaries.py`
- Modify: `README.md`
- Modify: `docs/ai-rebuild/security-review.md`
- Modify: `docs/ai-rebuild/methodology-assessment.md`
- Modify: `docs/architecture/node-http-migration-map.md`
- Modify: `backend-node/Dockerfile`
- Modify: `backend-ai/Dockerfile` only if an import path changed
- Modify: `compose.yaml`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml` or `.github/workflows/release.yml` only where their current contents name the old Express runtime or old Python factory

**Interfaces:**
- Boundary verifier consumes manifests/source/runtime commands and fails on Express packages/imports, duplicate route ownership, route decorators in the FastAPI facade, Django/Flask additions or changed public factory paths.

- [ ] **Step 1: Write failing repository boundary checks**

Assert documentation and manifests describe NestJS/Fastify for product APIs, FastAPI for synchronous AI/RAG, n8n for asynchronous work, no Express compatibility runtime and no Django/Flask. Assert Docker/Compose health commands still target the same paths and factories.

- [ ] **Step 2: Run RED against stale framework descriptions**

Run: `node scripts/verify-framework-boundaries.mjs && ./backend-ai/venv/bin/python -m pytest -q --no-cov tests/test_framework_boundaries.py`

Expected: FAIL with specific stale Express references or missing verifier policy.

- [ ] **Step 3: Update consumers and architecture evidence**

Update only framework/runtime statements made inaccurate by Tasks 2-14. Preserve ADR 0001 ownership, security conclusions, BDD terminology and deployment boundaries. Do not claim production, deployment, traffic or human acceptance. Keep image entrypoints stable unless Task 14 requires the documented compatible factory path.

- [ ] **Step 4: Run focused consumers and builds**

Run: `node scripts/verify-framework-boundaries.mjs && ./backend-ai/venv/bin/python -m pytest -q --no-cov tests/test_framework_boundaries.py && make test-api-client && make test-mcp && make test-n8n && cd web && npm run build && npm run test:integration && cd ../mobile/eisenhower-matrix && npm test -- --runInBand`

Expected: PASS with unchanged API-client, web, mobile, MCP and n8n contracts.

- [ ] **Step 5: Commit boundary/docs cleanup**

```bash
git add scripts/verify-framework-boundaries.mjs tests/test_framework_boundaries.py README.md docs/ai-rebuild docs/architecture backend-node/Dockerfile backend-ai/Dockerfile compose.yaml .github/workflows/ci.yml .github/workflows/deploy.yml .github/workflows/release.yml
git commit -m "docs: record Nest FastAPI boundaries"
```

Before committing, remove unchanged paths from the shown `git add` invocation; do not edit deployment files unless their current contents refer to the replaced factory/runtime.

### Task 16: Benchmark exact Express baseline against Nest/Fastify

**Files:**
- Create: `benchmarks/http-migration/package.json`
- Create: `benchmarks/http-migration/runner.mjs`
- Create: `benchmarks/http-migration/workload.mjs`
- Create: `benchmarks/http-migration/fixture-server.mjs`
- Create: `benchmarks/http-migration/report.mjs`
- Create: `benchmarks/http-migration/README.md`
- Create: `benchmarks/results/nest-fastify-migration.json`
- Create: `docs/benchmarks/2026-08-23-express-vs-nest-fastify.md`
- Create: `tests/test_http_benchmark_contract.py`

**Interfaces:**
- Scenarios: unauthenticated liveness; authenticated task list; authenticated task create with a unique idempotency key.
- Backends: deterministic in-memory/fake repository for transport isolation and isolated `MongoMemoryReplSet` for representative persistence.
- Measurements: warm-up, concurrency, p50/p95/p99 latency, requests/second, peak RSS and cold start.

- [ ] **Step 1: Write failing benchmark-method contract**

Require both implementations, both storage modes, three scenarios, concurrency `1`, `10`, `50`, at least `5` alternating repetitions, `5` seconds or `1000` requests of warm-up, `15` seconds measurement, `10` cold starts, raw samples, environment metadata and explicit synthetic/non-production limitations.

- [ ] **Step 2: Run RED before the runner exists**

Run: `./backend-ai/venv/bin/python -m pytest -q --no-cov tests/test_http_benchmark_contract.py`

Expected: FAIL because benchmark configuration/results are absent.

- [ ] **Step 3: Implement reproducible baseline/candidate runners**

Use `mktemp -d` for an exact `git archive 5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9` baseline, run `npm ci` there, and never mutate the baseline tree. Run baseline and candidate on the same host and detected Node executable/config. Alternate Express/Nest order per repetition. Generate authenticated test principals through injected verifier ports. Collect Linux RSS from `/proc/<pid>/status`; define cold start as process spawn until successful liveness response. Record CPU model, kernel, Node, package versions and git SHAs.

- [ ] **Step 4: Run the complete benchmark and generate raw/report artifacts**

Run: `node benchmarks/http-migration/runner.mjs --baseline-sha 5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9 --warmup-seconds 5 --measurement-seconds 15 --repetitions 5 --cold-starts 10 --concurrency 1,10,50 --storage memory,mongo`

Expected: exit `0`, raw JSON validates against the contract and the Markdown report contains all samples, medians/deltas and limitations. A regression is reported, not hidden; no minimum speedup is a completion condition.

- [ ] **Step 5: Review results and commit benchmark evidence**

Run: `./backend-ai/venv/bin/python -m pytest -q --no-cov tests/test_http_benchmark_contract.py`

Expected: PASS. If a candidate median p95, throughput, RSS or cold-start regression exceeds `20%`, add a root-cause note and either an optimization task executed before completion or an explicit accepted trade-off request to the user.

```bash
git add benchmarks/http-migration benchmarks/results/nest-fastify-migration.json docs/benchmarks/2026-08-23-express-vs-nest-fastify.md tests/test_http_benchmark_contract.py
git commit -m "perf: compare Express and Nest Fastify"
```

### Task 17: Rehearse local rollback without a data migration

**Files:**
- Create: `scripts/rehearse-node-transport-rollback.mjs`
- Create: `tests/test_node_transport_rollback_contract.py`
- Create: `docs/runbooks/node-transport-rollback.md`
- Create: `docs/evidence/2026-08-23-node-transport-rollback.md`

**Interfaces:**
- Candidate and baseline use the same isolated `MongoMemoryReplSet` and port-compatible environment.
- Sequence: Nest write/read and idempotency/Calendar-outbox operation; stop Nest; Express read/safe operation; stop Express; Nest read and reconciliation.

- [ ] **Step 1: Write a failing rollback evidence contract**

Require the exact baseline SHA, candidate SHA, shared database URI, process lifecycle, task revision/idempotency assertions, Calendar binding/outbox lease assertions, no schema transformation command and captured exit status for each phase.

- [ ] **Step 2: Run RED before the rehearsal exists**

Run: `./backend-ai/venv/bin/python -m pytest -q --no-cov tests/test_node_transport_rollback_contract.py`

Expected: FAIL because the script/runbook/evidence are absent.

- [ ] **Step 3: Implement the isolated rollback rehearsal**

Create the Express baseline in a temporary archive as in Task 16. Start one isolated `MongoMemoryReplSet`; launch candidate and baseline sequentially, never concurrently. Use public/task and internal Calendar APIs with deterministic test verifiers/keys. Do not run migration or destructive database commands. Always terminate child processes and the replica set in `finally` handlers.

- [ ] **Step 4: Execute Nest to Express to Nest and capture evidence**

Run: `node scripts/rehearse-node-transport-rollback.mjs --baseline-sha 5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9 --output docs/evidence/2026-08-23-node-transport-rollback.md`

Expected: exit `0`; the same task, revision, idempotency receipt, Calendar binding and durable outbox state are readable after both switches without data transformation.

- [ ] **Step 5: Verify and commit rollback evidence**

Run: `./backend-ai/venv/bin/python -m pytest -q --no-cov tests/test_node_transport_rollback_contract.py`

Expected: PASS.

```bash
git add scripts/rehearse-node-transport-rollback.mjs tests/test_node_transport_rollback_contract.py docs/runbooks/node-transport-rollback.md docs/evidence/2026-08-23-node-transport-rollback.md
git commit -m "test: rehearse Node transport rollback"
```

### Task 18: Complete the local migration audit and TASK-066

**Files:**
- Create: `docs/architecture/nest-fastify-fastapi-migration-evidence.md`
- Modify: `.tasks/IN_PROGRESS.md`
- Modify: `.tasks/DONE.md`
- Modify: `.tasks/WORK_LOG.md`
- Modify: `docs/architecture/node-http-migration-map.md`

- [ ] **Step 1: Audit design/spec coverage before claiming completion**

Inspect every spec completion criterion and record its command/artifact in the evidence document. Include explicit conclusions for CSRF/browser protections, HTTP transport, durable messaging/jobs/webhooks, semantic command/query separation, ports-and-adapters boundaries, executable BDD coverage and the fact that passing tests do not prove historical TDD. Confirm:

```bash
git merge-base --is-ancestor 5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9 HEAD
node scripts/verify-framework-boundaries.mjs
rg -n "from ['\"]express|require\(['\"]express|express-validator|express-rate-limit|supertest" backend-node --glob '!package-lock.json'
rg -n "@app\.|@router\." backend-ai/app/main.py
git diff --check 5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9..HEAD
```

Expected: baseline is an ancestor; verifier passes; both forbidden-source searches return no matches; diff check passes. Verify TASK-065 has the same bytes as in `5db1983d` before moving TASK-066.

- [ ] **Step 2: Run fresh focused verification from clean dependencies**

Read and apply `superpowers:verification-before-completion`, then run:

```bash
make prepare-verify
cd backend-node && npm run build && npm run typecheck && npm run test:coverage && npm run test:bdd
cd ../backend-ai && ./venv/bin/python -m pytest -q
cd .. && make test-api-client && make test-mcp && make test-n8n
cd web && npm run build && npm run test:coverage && npm run test:integration
cd ../mobile/eisenhower-matrix && npm test -- --runInBand
```

Expected: all commands exit `0`; record exact counts and coverage without treating them as proof of historical TDD.

- [ ] **Step 3: Re-run the proportional root gate and evidence gates**

Run:

```bash
make verify
./backend-ai/venv/bin/python -m pytest -q --no-cov tests/test_http_benchmark_contract.py tests/test_node_transport_rollback_contract.py tests/test_framework_boundaries.py
git status --short
git diff --check
```

Expected: `make verify` and evidence contracts pass. Before TaskPlanner bookkeeping, only intended evidence/task files may be uncommitted. Report dependency-audit blind spots separately from successful package-manager checks.

- [ ] **Step 4: Close TASK-066 only when every local gate is satisfied**

Add a concise `### Outcome` to TASK-066 with exact local evidence and limitations, move its whole section from `.tasks/IN_PROGRESS.md` to `.tasks/DONE.md`, and add a newest-first `.tasks/WORK_LOG.md` entry. Leave TASK-065 byte-for-byte unchanged and keep `.tasks/config.json` at `nextId: 67`. If any code, test, docs, benchmark or rollback gate is red, keep TASK-066 In Progress and record the blocker instead.

- [ ] **Step 5: Commit the completion evidence and verify the commit**

```bash
git add docs/architecture/nest-fastify-fastapi-migration-evidence.md docs/architecture/node-http-migration-map.md .tasks/IN_PROGRESS.md .tasks/DONE.md .tasks/WORK_LOG.md
git commit -m "chore: complete TASK-066 migration evidence"
git status --short
git show --stat --oneline --decorate HEAD
```

Expected: clean worktree; final commit contains only intended evidence and TaskPlanner state. Completion means verified local source/contracts/benchmark/rollback only; it does not mean push, PR, promotion, artifact publication, deployment, runtime activation, production traffic or human acceptance.
