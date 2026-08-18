# TASK-065 Product, Calendar, and Local AI Design

## Goal

Make the matrix task-first: global creation utilities stay visible above it, assistance is scoped to one task, bulk review actually persists selected tasks, Calendar behaves predictably through explicit bindings, and optional local knowledge generation remains private and governed.

## Evidence and authorization boundaries

Source, tests, protected-branch CI, release artifacts, a local deployed SHA, enabled capability flags, live model health, observed user traffic, physical camera behavior, public deployment, and production acceptance are separate evidence classes. This work may promote an exact verified SHA through `dev` and `master` and deploy it to the supported private local runtime. It must not deploy to public Mikrus or enable user-visible generation or any MAG flag without a separate checksum-bound owner decision.

The existing `542a4908faa2847fca2efb9a425eacea89f90d54` private runtime remains the rollback target until the replacement passes authenticated smoke checks. The older `a018f986fefae8a1add6c4c5f929da5320771fde` Qwen/reranker runtime may be stopped only after the replacement and rollback path are proven; its volumes and images are retained until that decision.

## Information architecture

The primary matrix screen has three visible actions above the matrix: Add task, Scan photo, and Add in bulk. Add task opens or focuses the existing draft editor. Scan photo opens the OCR review utility with distinct Camera and Gallery controls. Add in bulk opens a dedicated batch-import review. Neither OCR nor bulk import appears inside task help.

Task help exists only on a persisted task card. It contains the MiniLM/PyTorch quadrant suggestion and, when the knowledge runtime reports the answer capability, one single-turn sourced question flow. The result is answer, inert citations, source preview, and an explicit preview/apply-to-description action. It is not chat and does not expose MAG management.

Top-level sections are Tasks, Integrations, and Account and security. Integrations owns Google Calendar status, connection, selected-event import/linking, synchronization, and conflict/deletion decisions. Account and security owns language, a Keycloak account-management link for password/reset/security, and logout. Provider/model/training controls stay outside the user product surface.

## OCR and bulk import

OCR accepts only byte-identified JPEG or PNG within existing byte, dimension, and pixel limits. Browser MIME and filename are advisory. JPEG EXIF/XMP/IPTC/comments and PNG text/EXIF chunks are removed before upload and the server repeats fail-closed validation. Camera and gallery are separate controls. Extracted rows remain editable/selectable with an explicit quadrant and a confirm step. Physical camera acceptance remains open.

Bulk import parses non-empty lines into stable client row IDs, classifies the normalized text through the existing MiniLM embedding plus PyTorch MLP batch endpoint, and then shows a review table. Each row is editable, selectable, and has a chosen quadrant. Duplicate detection is case-folded and whitespace-normalized against both the batch and the currently loaded task titles; duplicates default to excluded but can be deliberately included. Confirmation calls the existing idempotent task-create contract per selected row with a stable operation key retained across retries. The result reports created, duplicate-skipped, validation-skipped, and failed status per row. Partial success never becomes an all-or-nothing success message.

## Calendar ownership and lifecycle

Eisenhower owns task text, quadrant, lifecycle, schedule, reminder policy, and the choice to bind/import. Google owns unbound external events. Node owns OAuth grants, selected calendar, bindings, ETags, sync cursors, conflicts, mutation receipts, and the transactional outbox. n8n only claims/signals bounded Node operations; the Google adapter is the only provider HTTP boundary.

A task without a date never emits a Calendar delete. Adding a schedule creates an event only when a live connection and chosen calendar exist; otherwise the task date persists and the status is awaiting connection. Editing a bound schedule emits update. Clearing a bound schedule emits delete; clearing an unbound schedule is a no-op for Google. Timed events use explicit `start` and `end`, with a positive duration stored in the task schedule and a deterministic default when legacy data has no duration. Reminders are explicit: use Google defaults, disable, or supply supported override minutes.

Manual linking lists selected timed events from the chosen calendar without importing them. The user sees a diff, chooses Eisenhower-to-Google or Google-to-Eisenhower, and confirms a binding. Ownership, calendar ID, provider event ID, provider ETag, task revision, and uniqueness are checked atomically. Controlled import creates tasks only for explicitly selected events and returns a per-event result with stable idempotency.

When Google deletes a bound event, the binding enters a deletion decision instead of deleting a task. The choices are clear the Eisenhower date, recreate the Google event, or detach. Webhook notifications remain signals. Watch registration is queued immediately after connection instead of waiting for the scheduled workflow; reconciliation, syncToken, controlled 410 reset, HMAC replay receipts, outbox leases, and conflict decisions remain durable.

## AI capability routing and runtime

The classifier capability controls only quadrant suggestion and batch classification. OCR controls only Scan photo. Knowledge answer availability comes from the knowledge runtime's retrieval/response readiness, not the classifier boundary. The UI never infers answer availability from a generic RAG label and never shows a generation action when the response endpoint is disabled.

The private runtime keeps an authenticated boundary, host/origin allowlist, project/tenant authorization, approved checksum-bound corpus projection, bounded retrieval, optional generator, timeout, circuit breaker, explicit fallbacks, and aggregate observability. The user-visible response switch stays off unless a separate decision binds exact source/deployment SHA, environment, cohort, duration, stop thresholds, and rollback. MAG read/write/augmentation stays off pending consent and retention decisions.

## Security and architecture assessment

Browser requests keep OIDC bearer tokens in memory with `credentials: 'omit'`; state-changing endpoints retain Origin/CORS checks, authorization scopes, owner/tenant isolation, ETag/If-Match, and idempotency keys. This avoids cookie-authenticated CSRF exposure, while Origin validation remains defense in depth. Calendar internal calls keep request-bound HMAC and replay receipts.

The repository is a pragmatic layered/service-oriented monorepo. Calendar already has a meaningful Google port/adapter and separate application services, but the whole repository is not strict hexagonal architecture or full CQRS. Commands and queries will stay distinct where mutation/outbox behavior benefits; simple reads need no ceremonial bus. Mongo transactions plus outbox and n8n jobs/webhooks remain the messaging model. Existing Gherkin scenarios are executable BDD for their covered behavior only. New work follows recorded RED/GREEN cycles; passing tests alone are not evidence that historical code was written with TDD. DDD claims remain limited to explicit ownership language and Calendar/task boundaries, not aggregates across the entire system.

## Verification and delivery

Each behavior starts with a focused failing test. Verification expands from component/application tests to API-client, Node Calendar, n8n workflow contracts, web build/format/integration, mobile contracts, backend AI, and `make verify`. The candidate is then promoted feature-to-`dev` and `dev`-to-`master` with exact-head required checks, post-merge push CI, master-to-dev synchronization, and refreshed final equality. The exact final SHA is deployed privately; authenticated task, OCR, bulk, Calendar, capability, health, and rollback smoke checks run before the old runtime can be retired.
