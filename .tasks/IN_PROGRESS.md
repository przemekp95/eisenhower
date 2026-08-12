# In Progress

## TASK-047: Deploy the portable local AMD platform with Calendar and Remote MCP
**Priority:** P0 | **Tags:** calendar, mcp, oauth, n8n, amd, rocm, deployment

Deliver the approved platform end to end on the local AMD computer while keeping every application, automation, data, and inference boundary independently relocatable. Add controlled bidirectional Google Calendar synchronization and authenticated Remote MCP writes, then promote the exact verified result through `dev` to the default `master` branch.

### Plan

- Finish the mutation foundation with single-task ETags, durable idempotency, scoped OIDC authorization, privacy-safe audit coverage and a transactional Mongo outbox.
- Implement Calendar bindings, outbound and incremental inbound synchronization, explicit conflicts, deletion safety, `410 Gone` recovery, watch renewal and reconciliation through private n8n orchestration.
- Add narrow revision-safe Remote MCP mutation and calendar tools over Streamable HTTP with OAuth protected-resource metadata, explicit scopes, Host/Origin checks, rate limits and approval-safe annotations.
- Add an accessible connection, synchronization and conflict-resolution surface while keeping recurrence, all-day events, attendees, Meet and automatic invitations outside the first supported contract.
- Package application, automation, storage and inference as independently addressable services; qualify the exact local `gfx1151` ROCm/vLLM/model matrix and preserve classifier fallback when inference is unavailable.
- Run focused red-green loops, executable BDD, full repository verification and local end-to-end runtime checks, then promote only the exact green SHA through reviewed PRs to `dev` and `master`.

### Progress

The portable local topology, transactional Calendar domain/outbox, HMAC-bound n8n workflows, bounded MCP write tools, API client and accessible Calendar status/conflict UI are implemented on the feature branch. Point 1 is live on the local AMD host with per-user encrypted Google OAuth and an active Watch channel. Point 2 now has a fail-closed multi-user Keycloak boundary, pre-registered PKCE clients, exact resource audiences, scoped Node task authorization, a private Host/Origin/rate-limited gateway and Remote MCP token exchange that never passes the MCP bearer upstream. A real Keycloak 26.7 + Node + MCP SDK v2 rehearsal proved two stable subjects in one tenant, API owner isolation and the same 1-versus-0 result through 15 network MCP tools; the production realm contains no users or password grant. Point 4 now has exact-source AMD ROCm BGE-M3 retrieval and Qwen generation-shadow evidence on `gfx1151`, including strict PL/EN schema, citations and physical rollback. Final promotion remains fail-closed: the exact final source still needs the full repository/CI run and deployment update; the classifier's frozen 240-case production set lacks required dual-human labels/adjudication; response no-answer quality remains below its zero-tolerance gate; and ordinary task update/lifecycle/delegation APIs still need durable mutation receipts beyond `If-Match`.

---

## TASK-014: Run the retrieval-only shadow pilot
**Priority:** P1 | **Tags:** rag, shadow, production, observability

Deploy retrieval-only to an allowlisted internal cohort with `RAG_GENERATION_ENABLED=false` and `RAG_RESPONSE_ENABLED=false`, then compare aggregate retrieval quality, latency, freshness, errors, and fallback health without exposing retrieved content.

### Plan

- Build an immutable AMD ROCm application image with the selected pinned BGE-M3 dense retriever and deploy it only to the local owner cohort.
- Seed the owner-approved frozen corpus through canonical MongoDB into the rebuildable Qdrant projection, then verify reconciliation and isolation.
- Exercise privacy-safe local traffic, record aggregate retrieval/latency/error/fallback evidence, and prove generation and user-visible response remain off during this phase.
- Rehearse the retrieval disable switch, restore the admitted shadow state, and record the bounded go/no-go decision.

### Progress

The physical `gfx1151` GPU passed PyTorch ROCm execution. Pinned BGE-M3 dense retrieval passed the untouched holdout for Recall@5 `1.0`, MRR@5 `0.7778`, p95 `100.6431 ms`, isolation, forbidden, stale and duplicate rates `0`; hybrid and the cross-encoder reranker were rejected. The exact-source ROCm application image then loaded 25 canonical documents into a green 235-point local Qdrant projection and completed a real authorized retrieval-to-Qwen shadow request without exposing generated content. The physical inference stop/restart drill also passed. The retrieval-only no-answer score `0.8333` remains a user-response blocker, not hidden or tuned away; a bounded aggregate-traffic pilot and production-approved classifier artifact are still required before completion.

---

## TASK-015: Qualify the selected live GPU, runtime, model and quantization
**Priority:** P2 | **Tags:** rag, vllm, gpu, citations

After retrieval proves useful, qualify a licensed model on the exact physical NVIDIA/CUDA or AMD/ROCm host and prove that its pinned runtime satisfies the private generation contract, capacity and failure gates.

### Plan

- Run the pinned Qwen3-4B-Instruct-2507 candidate in the digest-pinned vLLM ROCm image on the local `gfx1151` GPU and record the exact model, tokenizer, chat template, dtype, runtime and memory identity.
- Bind the immutable PromptSpec only after live startup and PL/EN structured-output contracts pass.
- Run health, private-network, schema, citation, no-answer, injection, latency, capacity, restart, OOM/disconnect and fallback gates without weakening validation.
- Record a go/no-go decision and keep generation disabled if any zero-tolerance gate fails.

### Progress

Digest-pinned vLLM ROCm 0.20.0 now serves revision-pinned Qwen3-4B-Instruct-2507 in BF16 on physical `gfx1151`. Exact PL/EN PromptSpecs, chat-template hash, authenticated model identity, strict structured output and grounded citation validation passed live 4/4; the end-to-end shadow executed BGE-M3 and Qwen on AMD, and a real stop/restart rollback recovered healthy. Observed post-load use was about 2.98 GiB visible VRAM plus 45.09 GiB GTT, and pre-restart traffic placed p95 end-to-end latency in the 10-second bucket. Qualification remains open for explicit injection/no-answer adversarial coverage, bounded concurrency/capacity and OOM/disconnect fallback evidence; these gates are not inferred from the successful happy path.

---

## TASK-023: Run private generation shadow and response canary
**Priority:** P2 | **Tags:** rag, generation, shadow, canary, production

Deploy the qualified private inference matrix behind FastAPI, discard validated generated output during a bounded shadow, and expose grounded responses only to an approved cohort after quality, security, availability and rollback gates pass.

### Plan

- Run private generation shadow on the allowlisted local owner cohort with validated output discarded and aggregate-only telemetry.
- Require grounded citations, strict no-answer behavior, schema validity, PL/EN quality, stable latency/errors and zero isolation or prompt-injection violations.
- Rehearse generation and response disable switches plus model rollback before exposing any answer.
- Enable user-visible responses only for the bounded cohort after every zero-tolerance gate is green, then verify the real client flow and preserve an exact-SHA decision record.

### Progress

Private generation shadow is now real: the application invokes Qwen, validates the strict PL/EN schema and grounded citations, discards the generated explanation, and records aggregate-only evidence. A full BGE-M3 -> authorized Mongo/Qdrant -> Qwen request passed on the local AMD GPU, and response exposure is additionally constrained by tenant and stable-user allowlists. User-visible responses remain fail-closed because the frozen 240-case classifier production set has no genuine dual-human labels/adjudication and retrieval no-answer accuracy is `0.8333` against a required `1.0`. The opened holdout will not be tuned against; a new balanced calibration-dev set and separately sealed v2 holdout are required. The implemented answer is a grounded quadrant explanation, not generic knowledge Q&A.

---

## TASK-019: Implement consent-governed Memory-Augmented Generation
**Priority:** P1 | **Tags:** mag, memory, privacy, consent, evaluation

Implement MAG as a separate user-memory domain with MongoDB as source of truth and a rebuildable Qdrant projection. Memory writes require explicit consent and confirmation; autonomous inference, silent conflict resolution and relabeling classifier feedback as memory are forbidden.

### Plan

- Specify memory identity, provenance, consent, retention/TTL, supersession, status, export and deletion contracts plus scoped commands and queries.
- Implement the pre-gate synthetic domain/application slice with in-memory fakes only: explicit confirmation, idempotency, scope enforcement, conflicts and projection revalidation.
- Keep user-facing routes, jobs and real-user writes deferred; implement local fail-closed Mongo/Qdrant adapters, reconciliation, prompt projection and disabled runtime flags as pre-rollout evidence.
- Build a separate Qdrant memory projection and revalidate every retrieved hit against MongoDB before using the bounded memory prompt budget.
- Add PL/EN evaluation for benefit, false memory, stale/conflict behavior, poisoning, isolation, deletion/export completeness, latency and token impact.
- Roll out behind independent write, retrieval and response flags with shadow/canary evidence and a rehearsed disable/rebuild path.

### Resume gate

Design and synthetic tests may proceed before production RAG, but real memory writes and response augmentation require approved consent/retention ownership plus stable TASK-010 through TASK-015 and TASK-023 retrieval/generation rollout evidence.

### Progress

The owner policy, fully intent-bound HMAC confirmations, typed fail-closed policy validation, transactional Mongo repository, replay-safe lifecycle, explicit active-conflict keys, atomically idempotent supersession, separate content-free Qdrant projection, pre-ranking status/expiry filters, canonical overfetch/revalidation/risk-aware ranking, bounded untrusted prompt projection and PL/EN evaluation framework are implemented locally. A refreshed isolated Mongo replica-set + real Qdrant test proved cross-tenant/user isolation, tampered-projection rejection, duplicate-conflict transaction rollback, orphan cleanup, physical deletion and replay after clock movement, then removed its database, collection and container. All memory rollout flags remain false; no user-facing write, retrieval or response augmentation is enabled, and real-user shadow/canary remains gated by TASK-013 through TASK-015 and TASK-023.

---

## TASK-020: Publish the recruiter-facing AI case study and demo
**Priority:** P1 | **Tags:** recruitment, portfolio, ai, documentation, demo

Package the verified RAG, document extraction, MAG, MCP, n8n, security, evaluation and operations evidence as a public technical case study and bounded demo. Do not advertise a dependency, mock, scaffold or local-only result as a running capability.

### Plan

- Present the immutable architecture, trust boundaries, ADR decisions, exact runtime status and intentional non-goals.
- Publish reproducible PL/EN evaluation reports, citations, failure/fallback behavior, privacy controls and rollback evidence without exposing corpus content or PII.
- Demonstrate the web/API flow plus read-only MCP and AI-specific Prometheus/Grafana views against the same approved SHA.
- Verify accessibility, mobile/desktop UX, public HTTPS behavior and every external claim before publication.

### Resume gate

Build the case-study structure during implementation, but publish capability claims only after the corresponding TASK-010 through TASK-019 and TASK-023 evidence exists. Any public deployment still requires explicit authorization.

### Progress

Created a private evidence-led case-study draft with current artifact hashes, the failed retrieval baseline, ADRs/non-goals and explicit separation of source, tests, local runtime, deployment and public proof. The refreshed MCP rehearsal proves all six tools through a real stdio subprocess/SDK handshake against current Node/FastAPI, isolated MongoDB/Qdrant, five citations and zero wrong-project hits. The web now has an accessible PL/EN RAG/fallback/no-answer surface; a separate unmocked Chromium desktop/Pixel 7 rehearsal proves current Vite → FastAPI → MiniLM → isolated Mongo/Qdrant citation flow with wrong-user ACL denial and complete cleanup. n8n raw-body signing is hardened in source, but the workflow is not imported or active. Fresh broad regression evidence is backend AI 365 passed/7 skipped at 89.86% coverage, Node 66 plus build, web 134 at 100% plus build/format and 6 Playwright checks, MCP 21 with warnings as errors, and n8n 5/5. The earlier Prometheus/Grafana rehearsal remains historical source-bound evidence, not current same-release telemetry. No immutable release image, live vLLM, deployed telemetry, public HTTPS, publication or deployment is claimed.

---

## TASK-001: Complete independent dual-human classifier annotation
**Priority:** P0 | **Tags:** ai, evaluation, human-gate

Collect two blind, independent human annotations for the 240-item PL/EN packet, measure raw agreement and Cohen's kappa, adjudicate disagreements, verify at least 30 examples in each language/class slice, and preserve immutable evidence. AI output cannot substitute for either annotator.

### Plan

- Provide the hidden-label pool, two blank response files, and annotation guide.
- Freeze both completed files before comparison and calculate agreement.
- Human-adjudicate disagreements, supplement weak slices if needed, then obtain explicit human approval.

### Conditional checkpoint

The repository owner approves this human gate green without reservations through 2026-08-15 23:59:59 Europe/Warsaw, so it does not block downstream work. Preserve the annotation files and metrics truthfully; owner approval does not require inventing file contents or computed kappa.

---
