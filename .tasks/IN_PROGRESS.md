# In Progress

## TASK-051: Promote the runtime-footprint work through green dev and master
**Priority:** P0 | **Tags:** release, ci, runtime, rag, promotion

Integrate every unpublished commit from `codex/runtime-footprint-20260815` with the current remote development
line, extend the owner's active conditional checkpoints consistently through 2026-08-23 23:59:59
Europe/Warsaw, and promote the exact verified source through the required PR-to-dev and dev-to-master workflow
without deploying or changing production runtime state.

### Plan

- Reconcile the current `origin/dev`/`origin/master` ancestry and independently merged LlamaIndex work without
  stash, history rewriting, contract regression or loss of either line's evidence.
- Extend only active conditional checkpoints; preserve historical timestamps, consumed approvals and immutable
  benchmark evidence.
- Run the full local release gate and inspect the final security, HTTP/browser, async jobs/outbox, CQRS,
  ports-and-adapters and TDD/DDD/BDD boundaries.
- Push the feature branch, merge a green exact-head PR to `dev`, then merge a green dev-only PR to `master` and
  verify post-merge CI for the exact remote SHA; do not deploy or modify production.

---

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

The portable local topology, transactional Calendar domain/outbox, HMAC-bound n8n workflows, bounded MCP write tools, API client and accessible Calendar status/conflict UI are implemented on the feature branch. Point 1 is live on the local AMD host with per-user encrypted Google OAuth and an active Watch channel. Point 2 has a fail-closed multi-user Keycloak boundary, pre-registered PKCE clients, exact resource audiences, scoped Node task authorization, a private Host/Origin/rate-limited gateway and Remote MCP token exchange that never passes the MCP bearer upstream. The local Compose now includes the web UI behind that gateway with state-bound Authorization Code + S256 PKCE and memory-only access tokens. Point 4 has AMD ROCm BGE-M3 retrieval and Qwen generation-shadow evidence on `gfx1151`, including strict PL/EN schema, safe injection abstention, serialized capacity-two traffic at configured capacity one, oversize rejection without OOM, application-level disconnect fallback and physical recovery. An exact-SHA build/render/deploy/smoke/rollback script now covers all first-party images and verifies OCI source revisions. Final deployment remains fail-closed because a genuine production classifier evaluation file does not exist; the script refuses `/dev/null`, a mismatched digest or missing model/service keys instead of weakening readiness.

---

## TASK-014: Run the retrieval-only shadow pilot
**Priority:** P1 | **Tags:** rag, shadow, production, observability

Deploy retrieval-only to an allowlisted internal cohort with `RAG_GENERATION_ENABLED=false` and `RAG_RESPONSE_ENABLED=false`, then compare aggregate retrieval quality, latency, freshness, errors, and fallback health without exposing retrieved content.

### Plan

- Deploy the selected owner-authorized hybrid BGE strategy with its private pinned reranker on the local AMD cohort.
- Preserve aggregate-only telemetry, canonical authorization and independent retrieval/generation/response switches.
- Rehearse disable and restore paths before recording the final bounded decision.

### Progress

The earlier exact-source ROCm image loaded 25 canonical documents into a green 235-point local Qdrant projection and completed a real authorized BGE-M3-to-Qwen shadow request without exposing generated content. The newer `dev` strategy adds owner-authorized fielded BM25/RRF and a separate fail-closed pinned reranker; its local deployment must be rehearsed together with the qualified generator before this pilot can close.

---

## TASK-015: Qualify the selected live GPU, runtime, model and quantization
**Priority:** P2 | **Tags:** rag, vllm, gpu, citations

After retrieval proves useful, qualify a licensed model on the exact physical NVIDIA/CUDA or AMD/ROCm host and prove that its pinned runtime satisfies the private generation contract, capacity and failure gates.

### Plan

- Preserve the revision-pinned Qwen3-4B-Instruct-2507 BF16 runtime and immutable PL/EN PromptSpecs.
- Complete adversarial no-answer/injection, bounded concurrency/capacity and disconnect/fallback checks on physical `gfx1151`.
- Record exact runtime, memory, restart and rollback evidence without inferring untested OOM behavior.

### Progress

Exact-image vLLM ROCm 0.26.0 now serves revision-pinned Qwen3-4B-Instruct-2507 in BF16 on physical `gfx1151`; exact v0.20.0 remains the rehearsed rollback. Live PL/EN structured output, authentication, exact model identity, grounded citations and BGE scoring passed. Two concurrent requests serialized at configured `max-num-seqs=1`; an oversized request returned HTTP 400 without OOM/restart. Private mutex-protected stop/wake is bounded and fail-closed, with measured 16 GiB/3 CPU/320 PID inference limits and exact v0.26 → v0.20 → v0.26 restoration. The selected model/runtime machine qualification is green for bounded single-user local capacity; production response quality remains a separate TASK-023 gate.

---

## TASK-023: Run private generation shadow and response canary
**Priority:** P2 | **Tags:** rag, generation, shadow, canary, production

Deploy the qualified private inference matrix behind FastAPI, discard validated generated output during a bounded shadow, and expose grounded responses only to an approved cohort after quality, security, availability and rollback gates pass.

### Plan

- Exercise integrated hybrid retrieval plus private generation with generated output discarded and aggregate-only telemetry.
- Add a separate knowledge-answer query contract instead of reusing classifier explanations or changing retrieval-search semantics.
- Require deterministic no-hit abstention, claim-level grounded citations, strict no-answer behavior, schema validity, PL/EN quality and zero isolation or injection violations.
- Rehearse answerable, unsupported, injected, provider-failure and cross-scope cases without tuning on the opened holdout.
- Freeze a separate balanced knowledge-answer holdout and immutable policy before its first live execution; score answerability, required facts, citations, schema and injection resistance without model-as-judge labels.
- Run that sealed packet once through the physical AMD/Qwen path, publish checksum-bound aggregate evidence and connect only the automated result to the response quality gate.
- Bind the response endpoint to the atomic promotion pointer, stable per-user percentage assignment and an expiring owner approval receipt; fail closed on stale, malformed or mismatched state.
- Apply the independently granted owner approval only through 2026-08-23 23:59:59 Europe/Warsaw, keep the existing tenant/user allowlists and rehearse automatic expiry plus rollback before local enablement.
- Keep user-visible responses disabled unless every zero-tolerance gate and explicit tenant/user allowlist is satisfied.

### Progress

Private Qwen generation shadow is real and generated content is discarded after strict validation. A separate `POST /v2/knowledge/answer` query contract now preserves search semantics and returns either one atomic claim with one authorized citation or a content-free `insufficient_evidence`; it never reuses classifier explanations as answers. Two-phase guided generation first decides answerability and only then produces the required cited claim, avoiding nullable/conditional-schema gaps observed on the physical vLLM decoder. OIDC scope, tenant/project ACL, browser rate limiting, tenant/user canary allowlists, provider failures and foreign citations all remain fail-closed. The web UI calls this Q&A contract and renders no quadrant or invented source for abstentions. Physical Qwen on AMD `gfx1151` passed PL answer, EN answer, unsupported private-data question and injected-context abstention 4/4; full `make verify` passed with 627 backend-AI tests/10 skips at 88.57% coverage, 240 Node tests, 21 BDD scenarios/107 steps, 186 web tests plus 2 integrations, 192 mobile tests, 50 MCP tests, audits, builds, typechecks and Pylint 10.00/10. User-visible responses remain disabled by default because this bounded smoke is not an independently human-reviewed answer-quality holdout; the 42 retrieval decisions and 240 classifier labels remain pending.

The separate technical response holdout is frozen at 24 fixed-context cases and its first physical AMD/Qwen run passed the predeclared automated policy: answerable recall 1.0, no-answer precision/recall 1.0/1.0, citation/schema/context binding 1.0, injection success 0.0, supported-answer rate 0.9167 and p95 2851.23 ms. Runtime now reloads the atomic response pointer per request, applies stable pseudonymous percentage routing only after tenant/user allowlists, records aggregate decisions and automatically fails closed when the owner approval expires. PRs #179/#180 promoted this source through green `dev` to master `c8072ad7`. A private knowledge-only AMD service isolates the governed answer route; the full local deployment now also carries the owner's explicitly time-bounded classifier evidence bypass without fabricating the still-empty dual-human labels, and fails classifier requests closed after that approval expires. Real canary traffic and post-expiry evidence remain open.

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

The repository owner approves this human gate green without reservations through 2026-08-23 23:59:59 Europe/Warsaw, so it does not block downstream work. Preserve the annotation files and metrics truthfully; owner approval does not require inventing file contents or computed kappa.

---
