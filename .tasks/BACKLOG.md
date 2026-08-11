# Backlog

## TASK-028: Add Grounded RAG and camera parity across web and mobile
**Priority:** P2 | **Tags:** product, rag, mobile, web, parity

Define the supported Grounded RAG and camera workflows on both clients, including platform capabilities, privacy, permissions, offline behavior, and acceptance evidence.

### Plan

- Decide which RAG and camera capabilities belong on each platform and define privacy/permission boundaries.
- Implement equivalent user-visible contracts where platform support permits it.
- Verify accessible desktop/mobile UX and physical camera behavior separately from mocked tests.

---

## TASK-027: Add complete, archive, and trash lifecycle states
**Priority:** P2 | **Tags:** product, lifecycle, tasks

Define and implement reversible task completion, archive, trash, restore, and final deletion semantics without conflating the Delete quadrant with physical deletion.

### Plan

- Decide lifecycle transitions, retention, restore behavior, filtering, and synchronization conflict rules.
- Implement the API, storage, web, and mobile contracts with migration and accessibility coverage.
- Verify reversible and permanent operations independently.

---

## TASK-026: Add Delegate assignee and status workflow
**Priority:** P2 | **Tags:** product, delegate, tasks

Define the assignee identity, handoff, status, authorization, and notification model for Delegate tasks before extending persistence or clients.

### Plan

- Decide supported assignee identities, permissions, delivery states, and single-tenant versus OIDC behavior.
- Implement the approved API/storage/client workflow with audit and conflict coverage.
- Verify cross-user authorization and notification behavior against the chosen product contract.

---

## TASK-025: Add Schedule due dates and reminders
**Priority:** P2 | **Tags:** product, schedule, reminders

Define due-date, timezone, recurrence, delivery, permission, offline, and notification semantics for Schedule tasks before implementation.

### Plan

- Decide timezone and reminder ownership semantics plus supported delivery channels.
- Implement persistence, API, web, mobile, and background delivery only after the product contract is approved.
- Verify timezone boundaries, missed reminders, retries, permissions, and physical notification delivery.

---

## TASK-014: Run the retrieval-only shadow pilot
**Priority:** P1 | **Tags:** rag, shadow, production, observability

Deploy retrieval-only to an allowlisted internal cohort with `RAG_GENERATION_ENABLED=false` and `RAG_RESPONSE_ENABLED=false`, then compare aggregate retrieval quality, latency, freshness, errors, and fallback health without exposing retrieved content.

### Plan

- Require the supported P0 release gates and TASK-010 through TASK-013 to pass first.
- Deploy an immutable SHA with a rollback flag and bounded tenant cohort.
- Review telemetry and human samples, rehearse disable/rollback, and record a go/no-go decision.

### Resume gate

Requires explicit deployment authorization, approved production origins/identity, real traffic, monitoring ownership, and privacy-safe sampling.

---

## TASK-015: Qualify the selected live GPU, runtime, model and quantization
**Priority:** P2 | **Tags:** rag, vllm, gpu, citations

After retrieval proves useful, qualify a licensed model on the exact physical NVIDIA/CUDA or AMD/ROCm host and prove that its pinned runtime satisfies the private generation contract, capacity and failure gates.

### Plan

- Record exact accelerator, VRAM, driver, runtime, vLLM image digest, model/license/revision, tokenizer/chat template, dtype or quantization, context and concurrency.
- Run the live structured-output, auth, health, metrics, latency, capacity, VRAM, OOM, disconnect and fallback gates on the selected local or dedicated host.
- Preserve a comparable evidence packet and reject any matrix that cannot meet the application contract without weakening validation or fallback.

### Resume gate

Blocked until TASK-014 and TASK-022 pass and hardware, model, license, residency and operations owners make the recorded decisions. Mock HTTP and Compose rendering cannot complete this task.

---

## TASK-023: Run private generation shadow and response canary
**Priority:** P2 | **Tags:** rag, generation, shadow, canary, production

Deploy the qualified private inference matrix behind FastAPI, discard validated generated output during a bounded shadow, and expose grounded responses only to an approved cohort after quality, security, availability and rollback gates pass.

### Plan

- Require TASK-013 through TASK-015 and TASK-022, an immutable deployment SHA, approved privacy boundaries and owned telemetry/runbooks.
- Compare sampled shadow generation for groundedness, citations, no-answer, information delta, latency, errors, fallback and cost without changing user-visible responses.
- Rehearse disable and model rollback, then enable a small allowlisted cohort and expand only while every threshold remains green.

### Resume gate

Requires separate deployment authorization, a qualified physical host/model matrix, privacy-safe sampling, monitoring ownership and an approved rollback window. No production or public action is implied by source completion.

---

## TASK-006: Revisit the React Native 0.84 migration when Expo supports it
**Priority:** P3 | **Tags:** mobile, dependencies, deferred

Keep the supported Expo 55 dependency baseline. Reassess React Native 0.84 or newer only after a stable Expo release supports it and the full mobile and native Android gates can run.

### Plan

- Check the stable Expo compatibility matrix when a newer supported line exists.
- Upgrade as one deliberate platform migration and run the complete mobile/native Android verification.

---
