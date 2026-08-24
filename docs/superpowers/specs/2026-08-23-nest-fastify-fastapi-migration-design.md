# NestJS/Fastify and FastAPI Boundary Migration Design

## Status and objective

This design was approved in the architectural brainstorming conversation on 2026-08-23. The written specification remains subject to the repository owner's review before an implementation plan is created.

The objective is to replace the `backend-node` Express 5 transport with one NestJS 11+ application using the Fastify 5 adapter, while preserving all existing public and internal contracts. FastAPI remains the owner of synchronous AI/RAG and is modularized so that `backend-ai/app/main.py` is no longer an oversized composition root. The migration ends with no Express runtime or duplicate transport implementation, fresh contract verification, a comparative benchmark, and a locally rehearsed rollback.

## Authoritative baseline

The migration baseline is the clean exact commit `5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9`. At design time, refreshed refs satisfy:

- `HEAD == origin/dev == origin/master == 5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9`;
- `backend-node` uses Express `^5.2.1`, Mongoose `^9.9.2`, Jest and Cucumber;
- `backend-ai` uses FastAPI `0.141.1`, Pydantic `2.13.4` and Uvicorn `0.52.3` at its boundary;
- `backend-ai/app/main.py` is 1,146 lines at the baseline;
- ADR 0001, `docs/ai-rebuild/adr/0001-fastapi-owns-online-rag.md`, is accepted;
- TASK-065 remains In Progress and owns its product, Calendar, governed RAG and local-runtime delivery gates.

The exact baseline commit, not a mutable local `dev` checkout, is the behavioral oracle and rollback source. If remote refs move before implementation begins, the plan must record the new implementation base and explicitly reconcile it with this approved baseline rather than silently changing the oracle.

## Architectural decision

The selected approach is a contract-first evolutionary replacement with one final target runtime. Express is retained only as a frozen behavioral oracle during migration. It is not a permanent sidecar, gateway branch or second production service.

The target rules are:

1. **Framework-first for implementation.** Prefer NestJS components or Fastify plugins for ordinary transport, composition and cross-cutting technical concerns. Existing custom implementations have no automatic right to remain.
2. **Contract-first for behavior.** Replacing an implementation must preserve externally visible behavior and required durability unless a later, explicit design decision changes that contract.
3. **One owner per concern.** A concern such as CORS, validation or rate limiting is registered once. Nest and Fastify mechanisms must not overlap or double-apply behavior.
4. **No duplicate business logic.** Controllers and transport adapters delegate to one application/domain implementation. There is no Express copy and Nest copy of a use case.
5. **No permanent dual stack.** The final dependency graph and source tree contain no Express bootstrap, routers, middleware packages, Express types or duplicate route implementation.

This project remains a pragmatic modular, layered and ports-and-adapters application. Nest modules do not by themselves establish DDD or CQRS. Commands and queries are introduced only where write intent, side effects or read isolation make the separation useful. A generic repository hierarchy, ceremonial framework bus and framework types in core contracts are out of scope.

## Target `backend-node` architecture

One Nest application is bootstrapped with `FastifyAdapter`. `AppModule` is a thin composition boundary. The target modules are:

- **ConfigModule:** validated environment configuration and production fail-closed requirements;
- **HealthModule:** liveness and readiness, including database and AI dependency state;
- **AuthModule:** static Bearer or OIDC verification, principal construction, scopes and trusted browser Origin;
- **AuditModule:** request-bound tamper-evident audit with fail-closed security behavior;
- **TasksModule:** task reads, writes, lifecycle, delegation, optimistic concurrency, idempotency and pagination;
- **CalendarModule:** status, event selection, imports, bindings, conflicts, deletion decisions, synchronization, durable outbox, webhook signals and reconciliation;
- **GoogleIntegrationModule:** OAuth state/callback/disconnect and Google Calendar provider adapters.

Controllers are thin HTTP adapters. DTOs and pipes validate transport input, guards authorize, interceptors or Fastify hooks handle request context and response metadata, and exception filters map errors to the existing wire format. Application services own use-case orchestration. Domain/application ports remain free of Nest, Fastify, HTTP request/response and provider SDK types.

Existing MongoDB collections remain canonical. Existing Mongoose repositories and Google ports may be retained, adapted or replaced behind the same application boundaries. The selection is made by contract, maintainability and measured value rather than by preserving custom code for its own sake.

## NestJS and Fastify component policy

NestJS is the default owner for modules, dependency injection, controllers, guards, pipes, interceptors, exception filters and lifecycle hooks. Fastify is the default owner for server-level HTTP behavior such as security headers, CORS, body parsing, raw body access, body limits, proxy behavior and any adapter-specific rate-limiting plugin.

For each cross-cutting concern, implementation work must document:

- the selected Nest component or Fastify plugin;
- why it is the single owner;
- its observable contract against the Express baseline;
- any adapter needed to retain durable or application-specific guarantees;
- the evidence that the removed custom implementation is no longer referenced.

A component may replace the current audit, outbox or other custom implementation if it provides the required contract and durability, including any necessary adapter or persistent backing service. Introducing Redis, a broker, new canonical storage or a data migration is not implicitly authorized by this framework migration; it requires an explicit design amendment because it changes operational and rollback scope.

## Transport-independent contract harness

Before a route is replaced, a reusable harness must describe the request, dependencies, expected response and observable side effects independently of Express, Nest and Supertest-specific types. The same case runs against:

- the frozen Express baseline from exact SHA `5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9` in an isolated checkout or immutable local artifact; and
- the Nest/Fastify candidate through `app.inject()` or an equivalent real HTTP boundary.

The harness compares method, path, query parsing, request headers, response status, response headers, JSON schema and exact error body. It also compares relevant state in MongoDB, audit records, idempotency records, outbox entries, replay receipts and provider-adapter calls.

Only explicitly nondeterministic values such as generated request IDs, timestamps or ephemeral ports may be normalized. Each normalization is named and field-scoped. The harness must not sort semantically ordered arrays, drop unknown fields, coerce types or otherwise hide contract drift.

A migration map records every route, owning module, middleware/guard chain, scopes, request and response schemas, error cases, side effects and consumers in `packages/api-client`, web, mobile and n8n. A route is complete only when the map identifies one final Nest controller owner and its differential cases pass.

## Preserved Node HTTP contracts

The migration preserves, without client changes:

- every path and HTTP method;
- request and response JSON fields, nullability and validation bounds;
- success, validation, authorization, conflict, not-found, gone, rate-limit, body-limit and internal-error status/body pairs;
- `ETag` generation and strict `If-Match` parsing, including malformed, weak and unsafe-integer rejection;
- `Idempotency-Key` syntax, tenant/owner scope, payload conflict, concurrent behavior, replay status and replay headers;
- pagination query rules, cursor format, `X-Next-Cursor` and `Link` headers;
- `Authorization`, `WWW-Authenticate`, OIDC claims, Bearer modes and endpoint scopes;
- trusted Origin and CORS allowlist behavior, allowed/exposed headers, methods and `credentials: false`;
- rate-limit identity, trusted proxy behavior, limits, response status and standard headers;
- validated or generated `X-Request-ID` and its audit correlation;
- tamper-evident audit record shape, chain/HMAC and fail-closed behavior;
- the production `RELEASE_SHA`, audit secret/path and configuration gates;
- the `32kb` JSON body limit, raw-body requirements and exact `413` response;
- exact `404` and production-safe `500` response bodies.

## Tasks and Calendar invariants

Task controllers preserve ownership and tenant isolation, lifecycle transitions, delegation semantics, revision increments, scheduling and idempotent create/update/delete behavior. No framework DTO may become the canonical task model or repository interface.

Calendar and Google integration preserve:

- OAuth state creation, expiry and single use;
- safe return-origin and redirect rules;
- callback, token refresh, disconnect and immediate watch-registration behavior;
- selected calendar, binding uniqueness, Google event ID and provider ETag handling;
- controlled imports and per-event idempotency;
- transactional task mutation plus outbox creation where currently guaranteed;
- outbox status, availability, lease ID, lease timeout, retry, acknowledgement and dead-letter semantics;
- HMAC input, request-ID binding, constant-time verification and durable replay receipts;
- webhook validation, watch renewal, sync token, controlled `410` reset and reconciliation;
- conflict and external-deletion decision flows;
- provider failure mapping and no direct provider HTTP outside its adapter.

An in-memory Nest event emitter or Fastify hook is not, by itself, equivalent to a durable outbox. A Nest/Fastify-aligned replacement is allowed only when the complete persistence, retry, idempotency and recovery contract is maintained and differentially verified.

## Browser security and CSRF assessment

The current browser clients send Bearer/OIDC authorization headers and use `credentials: 'omit'`; they do not authenticate state-changing requests with ambient session cookies. A synchronizer or double-submit CSRF token is therefore not part of the current contract.

Trusted Origin enforcement and CORS remain mandatory defense-in-depth and must not be weakened. Unsafe requests carrying an untrusted Origin continue to fail with the current status, body and audit behavior. A future change to cookie-based authentication is outside this migration and would require a new CSRF design and tests.

Helmet/security headers, CORS, parser/body limits, proxy trust and rate limiting must be tested against the real Nest/Fastify adapter. Configuration state alone is not evidence that the user-visible HTTP behavior is correct.

## Asynchronous and integration boundaries

MongoDB remains canonical for product data. Qdrant remains a rebuildable AI search projection. n8n remains asynchronous-only and cannot enter the synchronous `/v2/ai/analyze`, search or answer path, write directly to Qdrant, or own Google credentials.

Durable background work remains expressed through explicit jobs, messages, webhooks or outbox entries. Any implementation replacement must preserve destination, payload, ordering assumptions, idempotency, lease and retry behavior. Nest events may coordinate in-process follow-up work but cannot silently replace a durable boundary.

## FastAPI ownership and modularization

ADR 0001 remains authoritative: FastAPI authenticates the principal, derives tenant/user/project scope, performs retrieval, optionally invokes generation, validates structured output and citations, and applies classifier fallback. n8n is never required for a synchronous answer. Django and Flask are not introduced.

The public `create_app(...) -> FastAPI` factory remains import-safe and retains its supported dependency-injection inputs. The boundary must still start in lightweight and knowledge-only roles without eagerly importing unavailable heavyweight providers.

The oversized composition root is divided by responsibility:

- **composition/dependencies:** resolve settings, classifier, RAG, auth verifiers, queue, metrics, audit, memory runtime and response canary;
- **middleware:** request context, authentication/Origin, audit preflight/result and exception behavior in the same effective order;
- **health/metrics router:** root identity, liveness, readiness and metrics;
- **analysis router:** `/v2/ai/analyze` and classifier-compatible legacy analysis routes;
- **knowledge router:** search and answer with ACL, citation and fallback behavior;
- **internal router:** webhook verification, ingestion, extraction, reindex and evaluation jobs;
- **training router:** examples, feedback, retraining, statistics and training-data administration;
- **operator/provider router:** capabilities and provider state operations;
- **OCR/batch router:** OCR extraction, OCR feedback and batch classification.

`backend-ai/app/main.py` becomes a compatibility facade and thin factory entrypoint rather than retaining route bodies and provider construction. Pydantic request/response models may move to focused schema modules, but existing imports used by tests or runtime entrypoints remain compatible or receive explicit compatibility re-exports.

The modularization preserves:

- Pydantic strictness, bounds and response models;
- generated OpenAPI paths, methods, operation visibility and schemas;
- Bearer/OIDC/internal verifier selection, scopes, ACL and trusted Origin;
- audit attempt/result ordering and fail-closed responses;
- request IDs, metrics names/labels and release SHA;
- webhook replay protection and job-queue semantics;
- citation validation, response canary, timeouts, circuit breaker and classifier fallback;
- lightweight import boundaries and role-specific dependency loading;
- no FastAPI, Pydantic, Qdrant or provider types in domain ports, jobs or canonical payload contracts.

## Migration sequence

The high-level replacement sequence is:

1. capture the Express contract/benchmark baseline and complete the migration map;
2. establish Nest/Fastify bootstrap, configuration, request context, parser limits and global error mapping;
3. replace health/readiness;
4. replace task reads, then task writes and concurrency/idempotency behavior;
5. replace auth, scopes, trusted Origin and audit integration;
6. replace public Calendar routes;
7. replace Google OAuth and provider routes;
8. replace internal Calendar HMAC, outbox, webhook and reconciliation routes;
9. modularize FastAPI behind unchanged public factories and contracts;
10. cut over the single Node bootstrap and remove every Express artifact;
11. run complete verification, comparative benchmark and rollback rehearsal.

During a RED/GREEN slice, an old router and its candidate controller may coexist only as short-lived transport adapters in the worktree. After parity for the slice, the old router is removed before the next completed slice. Application services, ports and business rules are never copied. The final source tree contains one owner for every route.

## TDD and verification strategy

Every new behavior or changed implementation starts with a focused failing test whose expected failure is observed before production code. Existing behavior first receives characterization or differential coverage. Such tests prove behavior; they do not retroactively prove that historical code was developed through TDD.

Verification expands proportionally:

- unit tests for application services, guards, pipes, filters, hooks and adapters;
- Nest/Fastify integration tests through the real adapter;
- isolated MongoDB integration tests for persistence and concurrency;
- executable BDD scenarios for covered user behavior;
- API-client, web, mobile and n8n contract suites;
- FastAPI import, router, OpenAPI, auth/ACL, audit, metrics, citation and fallback suites;
- production builds, TypeScript typecheck, lint/format and dependency gates;
- `make prepare-verify` before direct package tests in a fresh worktree;
- a fresh complete root `make verify` before completion.

The completion audit must map every route and named invariant in this design to fresh evidence. Passing a broad suite does not replace missing contract-specific evidence.

## Comparative benchmark

The benchmark compares the frozen Express baseline with final Nest/Fastify on the same machine, CPU allocation, operating system, Node version, build mode and configuration. It records dependency versions and the exact SHAs/artifacts used.

Representative cases are:

- liveness with no external dependency;
- an authenticated task read/list against a deterministic fake or in-memory repository;
- an authenticated task write against the same controlled repository;
- the same read and write against an isolated MongoDB instance with equivalent seeded state.

The benchmark declares warmup duration or request count, measurement duration, concurrency levels, payloads, connection reuse, number of repetitions and alternating run order. It reports per case and runtime:

- throughput;
- p50, p95 and p99 latency;
- process RSS at idle and under measured load;
- cold-start time to liveness and, separately, readiness.

Raw machine-readable results and a concise Markdown interpretation are retained. Results distinguish transport overhead from database behavior and identify noise, caching, JIT, garbage collection and sample-size limits. A local synthetic benchmark is not production performance, capacity or real-traffic evidence, and no minimum speedup is required for contract completion. Material regressions require explanation and an explicit accept/fix decision.

## Rollback

The rollback target is the exact Express baseline SHA/artifact. The transport migration cannot require an irreversible MongoDB migration. New fields, indexes or records, if any become necessary, must remain backward compatible or have a separately approved reversible migration.

A local rehearsal must prove that:

1. Nest/Fastify writes representative task, idempotency, Calendar and outbox state;
2. the candidate stops cleanly;
3. the Express baseline starts against the same compatible data;
4. representative reads and safe follow-up operations succeed without transforming data;
5. returning to Nest/Fastify also succeeds.

Rollback documentation identifies exact commands, configuration, artifact/SHA, data prerequisites and limitations. This rehearsal proves only local reversibility, not a deployed rollback.

## Relationship to TASK-065

TASK-066 does not modify, move or complete TASK-065. It preserves the task-first UX, Calendar lifecycle, OAuth/OIDC, HMAC, RAG capability and local-runtime contracts already established there. If current TASK-065 work advances those contracts before a migration slice begins, the migration map and baseline are refreshed and the delta is explicitly reconciled.

Runtime activation, corpus decisions, physical-device acceptance, real traffic, publication and production gates remain owned outside TASK-066. Architectural migration evidence must not be used to close them.

## Delivery and authorization boundaries

Authorized work is local source, tests, documentation, small commits and local verification in the isolated worktree. This design does not authorize:

- pushing commits or creating/merging pull requests;
- promoting or changing `dev` or `master`;
- publishing packages, images, SBOMs or other artifacts;
- deploying or activating any runtime;
- changing external routing, credentials or user data;
- claiming public, production, physical-device, human-acceptance or real-traffic proof.

TASK-066 may move to Done only when its local source, contract, documentation, benchmark and rollback gates are satisfied. Any later promotion, publication or deployment requires new explicit authorization.

## Completion criteria

The local task is complete only when all of the following are freshly evidenced:

- one NestJS 11+ application runs `backend-node` through Fastify 5;
- all Node public/internal routes and named contracts have differential parity;
- all consumers pass without contract changes;
- FastAPI still owns synchronous AI/RAG under ADR 0001;
- the FastAPI factory is import-safe and the former composition root is split into focused modules;
- security, CSRF applicability, HTTP transport, durable messaging/jobs/webhooks, CQRS scope and ports-and-adapters boundaries are explicitly verified;
- no `express`, `express-validator`, `express-rate-limit`, Express `cors`/`helmet` integration, `@types/express`, Express bootstrap, router or duplicate transport implementation remains;
- no framework/provider type leaks into core ports or canonical payload contracts;
- focused tests, builds, typechecks, lint and fresh root `make verify` pass;
- comparative benchmark results and limitations are recorded;
- local rollback against the exact Express baseline is rehearsed without an irreversible data migration;
- documentation and TASK-066 outcome state match the evidence;
- no unauthorized push, PR, promotion, publication, deployment or runtime activation occurred.
