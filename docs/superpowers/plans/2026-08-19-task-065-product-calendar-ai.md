# TASK-065 Product, Calendar, and Local AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver visible task creation utilities, real idempotent bulk import, explicit Google Calendar binding semantics, honest knowledge capability routing, and an exact-SHA private deployment.

**Architecture:** Keep UI orchestration in focused React components, task persistence and Calendar commands in Node application services/repositories, provider HTTP behind `GoogleCalendarPort`, AI inference in existing FastAPI boundaries, and n8n as a tokenless signal/job runner. Reuse ETags, idempotency receipts, owner scope, outbox, and HMAC instead of introducing a second integration path.

**Tech Stack:** React 19, TypeScript, Express, Mongoose/MongoDB transactions, FastAPI/Pydantic, Jest/Testing Library, Cucumber, Python unittest/pytest, n8n 2.4.6, Docker Compose, Keycloak OIDC.

**Spec:** `docs/superpowers/specs/2026-08-19-task-065-product-calendar-ai-design.md`

## Global Constraints

- Keep `credentials: 'omit'`, OIDC bearer auth, Origin/CORS checks, owner/tenant isolation, ETag/If-Match, and stable idempotency.
- Do not enable user-visible generation or any MAG flag without a separate exact-SHA owner decision.
- Do not remove the `542a4908` rollback runtime until authenticated replacement and rollback smoke pass.
- Do not claim physical camera, real traffic, public deployment, or production acceptance from automated evidence.
- Promote only the exact locally verified candidate through protected `dev` and `master`, then deploy that exact final SHA privately.

---

### Task 1: Visible utilities and task-scoped help

**Files:**
- Modify: `web/src/components/Matrix.tsx`
- Modify: `web/src/components/AITools.tsx`
- Modify: `web/src/components/matrixLazyComponents.tsx`
- Modify: `web/src/i18n/translations.ts`
- Test: `web/src/Matrix.test.tsx`
- Test: `web/src/components/AITools.test.tsx`

**Interfaces:**
- Produces: top-level `scan` and `bulk` utility dialogs; persisted task help with assistant-only content.
- Preserves: `onAddTask(task, idempotencyKey)` and per-task `onApplyDescription`/`onApplyQuadrant`.

- [ ] Write failing UI tests proving Scan photo and Add in bulk are visible above the matrix, OCR/bulk tabs are absent from task help, and draft help cannot open.
- [ ] Run focused Jest tests and confirm failures identify the old information architecture.
- [ ] Split the utility entrypoints from `AITools`, keep task help assistant-only, and add PL/EN labels.
- [ ] Run focused Jest tests and refactor shared dialog behavior without changing observable contracts.

### Task 2: Reviewable idempotent bulk import

**Files:**
- Create: `web/src/components/BulkImport.tsx`
- Test: `web/src/components/BulkImport.test.tsx`
- Modify: `web/src/components/Matrix.tsx`
- Modify: `web/src/hooks/useMatrixController.ts`
- Modify: `web/src/i18n/translations.ts`

**Interfaces:**
- Consumes: `batchAnalyzeTasks(string[])` and `onAddTask(TaskInput, idempotencyKey)`.
- Produces: `BulkImportSummary { created, duplicateSkipped, validationSkipped, failed, rows }` with one per-row outcome.

- [ ] Write failing tests for classify-review-edit/select/quadrant, duplicate defaults, explicit confirmation, stable retry keys, and honest partial results.
- [ ] Run the focused test and confirm it fails before `BulkImport` exists.
- [ ] Implement parsing, normalized duplicate detection, editable review, confirmation, and per-row retry-safe persistence.
- [ ] Run the focused test, Matrix regression, web build, and format check.

### Task 3: Integrations and account/security navigation

**Files:**
- Modify: `web/src/App.tsx`
- Create: `web/src/components/AccountSecurityPanel.tsx`
- Test: `web/src/App.test.tsx`
- Test: `web/src/components/AccountSecurityPanel.test.tsx`
- Modify: `web/src/oidcSession.ts`
- Modify: `web/src/i18n/translations.ts`

**Interfaces:**
- Produces: Tasks/Integrations/Account and security sections and a same-issuer Keycloak account-management URL.

- [ ] Write failing tests for section navigation, Calendar only under Integrations, language/security/logout under Account and security, and safe Keycloak account URL construction.
- [ ] Run focused tests and verify the current flat layout fails them.
- [ ] Implement the section shell and account panel without persisting bearer tokens.
- [ ] Run focused tests, accessibility queries, build, and format check.

### Task 4: Calendar schedule semantics

**Files:**
- Modify: `backend-node/src/models/task.ts`
- Modify: `backend-node/src/repositories/mongooseTaskRepository.ts`
- Modify: `backend-node/src/application/googleCalendar.ts`
- Modify: `backend-node/src/models/calendar.ts`
- Test: `backend-node/tests/calendar.test.ts`
- Test: `backend-node/tests/googleCalendarProvider.test.ts`
- Modify: `packages/api-client/index.js`
- Modify: `packages/api-client/index.d.ts`
- Test: `packages/api-client/index.test.js`

**Interfaces:**
- Produces: positive-duration timed event payloads and explicit reminder policy; create/update/delete only from binding-aware schedule transitions.

- [ ] Write failing tests for clear-without-binding no-op, schedule-before-connection persistence, create/update/bound-delete, positive end time, and reminders.
- [ ] Run focused Node/API-client tests and verify expected failures.
- [ ] Implement the minimal schedule/outbox/provider mapping while preserving transactions and receipts.
- [ ] Run focused Node/API-client tests and typecheck.

### Task 5: Selected Calendar linking, import, deletion decisions, and immediate watch

**Files:**
- Modify: `backend-node/src/application/calendar.ts`
- Modify: `backend-node/src/application/googleCalendar.ts`
- Modify: `backend-node/src/routes/calendar.ts`
- Modify: `backend-node/src/routes/calendarInternal.ts`
- Modify: `backend-node/src/models/calendar.ts`
- Modify: `web/src/components/CalendarSyncPanel.tsx`
- Modify: `web/src/services/api.ts`
- Modify: `packages/api-client/index.js`
- Modify: `packages/api-client/index.d.ts`
- Test: `backend-node/tests/calendar.test.ts`
- Test: `backend-node/tests/googleCalendarProvider.test.ts`
- Test: `web/src/components/CalendarSyncPanel.test.tsx`
- Test: `n8n/tests/test_workflow_contracts.py`

**Interfaces:**
- Produces: chosen-calendar event list, diff preview, unique link/import receipts, deletion-decision commands, and connection-time watch job.

- [ ] Write failing tests for ownership/calendar/ETag/uniqueness, both link directions, selected-only import, deletion choices, immediate watch, conflicts, and baseline without implicit import.
- [ ] Run focused Node/web/n8n tests and confirm the missing contracts fail.
- [ ] Implement application commands and DTOs behind existing routes/ports/outbox; extend the Integrations UI with explicit review/confirm controls.
- [ ] Run focused Node/web/n8n/API-client tests, build, and typecheck.

### Task 6: Honest knowledge capability routing and private runtime evidence

**Files:**
- Modify: `backend-ai/app/main.py`
- Modify: `backend-ai/app/knowledge_runtime.py`
- Modify: `web/src/components/AITools.tsx`
- Modify: `web/src/services/api.ts`
- Test: `backend-ai/tests/test_main.py`
- Test: `web/src/components/AITools.test.tsx`
- Modify: `deploy/local/deploy.sh`
- Test: `deploy/tests/local-deploy-contract.test.mjs`

**Interfaces:**
- Produces: separate classifier/OCR/batch/knowledge-answer availability and checksum-bound local rollout evidence; no automatic flag activation.

- [ ] Write failing tests proving classifier readiness cannot hide knowledge and disabled response cannot render generation.
- [ ] Run focused FastAPI/web/deploy contract tests and confirm expected failures.
- [ ] Route capabilities from the owning runtime, preserve timeouts/circuit/fallback/allowlist, and record deployment evidence without changing response/MAG flags.
- [ ] Run focused FastAPI/web/deploy tests and inspect the rendered private Compose configuration without secrets.

### Task 7: Full verification, exact-SHA promotion, and private deployment

**Files:**
- Modify: `.tasks/IN_PROGRESS.md`
- Modify: `.tasks/WORK_LOG.md`
- Verify: repository and runtime artifacts only.

**Interfaces:**
- Consumes: the exact candidate SHA from Tasks 1-6.
- Produces: exact remote dev/master SHA and CI evidence plus an exact-SHA private runtime with preserved rollback.

- [ ] Run focused suites, API/web/n8n contracts, builds, typechecks, lint, audits, and `make verify`; fix only evidence-backed failures.
- [ ] Re-read the spec requirement-by-requirement, run `git diff --check`, and confirm TASK-065 occurs in exactly one state file.
- [ ] Commit intended files, push the feature branch, open/update feature-to-dev PR, and wait for all required checks on the exact head.
- [ ] Merge to `dev`, verify exact post-merge push CI, then open/update the policy-compliant `dev`-to-`master` PR and verify exact-head checks.
- [ ] Merge to `master`, verify master push CI and master-to-dev sync CI, fetch, and prove final ancestry/equality.
- [ ] Build/deploy the exact final SHA to the supported private local runtime, run authenticated smoke and rollback checks, and retain the old runtime until they pass.
- [ ] Record outcome and newest-first work log entry; keep TASK-065 In Progress if activation, physical, or real-traffic acceptance remains open.
