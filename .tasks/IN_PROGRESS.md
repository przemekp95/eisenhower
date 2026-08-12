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

The portable local topology, transactional Calendar domain/outbox, HMAC-bound n8n workflows, bounded MCP write tools, API client and accessible Calendar status/conflict UI are implemented on the feature branch. Point 1 is live on the local AMD host with per-user encrypted Google OAuth and an active Watch channel. Point 2 now has a fail-closed multi-user Keycloak boundary, pre-registered PKCE clients, exact resource audiences, scoped Node task authorization, a private Host/Origin/rate-limited gateway and Remote MCP token exchange that never passes the MCP bearer upstream. A real Keycloak 26.7 + Node + MCP SDK v2 rehearsal proved two stable subjects in one tenant, API owner isolation and the same 1-versus-0 result through 15 network MCP tools; the production realm contains no users or password grant. Point 4 has exact-source AMD ROCm BGE-M3 retrieval and Qwen generation-shadow evidence on `gfx1151`, including strict PL/EN schema, grounded citations and physical inference rollback. Final promotion remains fail-closed until the merged exact source passes full verification and local deployment rehearsal; human evaluation and response-quality gates remain truthful and cannot be replaced by synthetic labels.

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

Digest-pinned vLLM ROCm 0.20.0 serves revision-pinned Qwen3-4B-Instruct-2507 in BF16 on physical `gfx1151`. Live PL/EN structured output, authentication, exact model identity and grounded citations passed 4/4; a real BGE-M3-to-Qwen request and physical stop/restart rollback passed. Post-load use was about 2.98 GiB visible VRAM plus 45.09 GiB GTT. Explicit adversarial, capacity and disconnect/fallback gates remain to be closed on the integrated strategy.

---

## TASK-023: Run private generation shadow and response canary
**Priority:** P2 | **Tags:** rag, generation, shadow, canary, production

Deploy the qualified private inference matrix behind FastAPI, discard validated generated output during a bounded shadow, and expose grounded responses only to an approved cohort after quality, security, availability and rollback gates pass.

### Plan

- Exercise integrated hybrid retrieval plus private generation with generated output discarded and aggregate-only telemetry.
- Require grounded citations, strict no-answer behavior, schema validity, PL/EN quality and zero isolation or injection violations.
- Keep user-visible responses disabled unless every zero-tolerance gate and explicit tenant/user allowlist is satisfied.

### Progress

Private Qwen generation shadow is real and generated content is discarded after strict validation. Response exposure additionally requires tenant and stable-user allowlists. User-visible responses remain fail-closed: the frozen 240-case classifier set lacks genuine dual-human labels/adjudication, while the previously opened retrieval holdout scored `0.8333` on no-answer. The newer balanced train/dev strategy reports no-answer `1.0`, but its independent decisions and untouched holdout remain pending; neither result is silently substituted for production approval.

---

## TASK-043: Compare dense, hybrid RRF and optional reranked retrieval
**Priority:** P1 | **Tags:** rag, retrieval, bm25, rrf, reranker, evaluation

Implement a disabled-by-default comparison path for the existing dense retriever, BM25 plus dense fusion with reciprocal rank fusion, and an optional bounded cross-encoder reranker. Every strategy must preserve the canonical MongoDB, tenant, project, ACL, version, tombstone and Qdrant projection boundary.

### Plan

- Add document-diverse fielded BM25/RRF candidates so repeated chunks cannot crowd out distinct relevant documents, while preserving canonical ACL/version/tombstone checks.
- Expand only train/dev with PL/EN, multi-document, exact-identifier and negative no-hit cases; keep the existing holdout byte-for-byte untouched.
- Select bounded parameters on train, validate once on dev, and keep dense as the runtime default unless every approved quality and zero-tolerance gate passes.
- Produce a new immutable exact-SHA comparison, run full regression and CI, then promote only evidence that remains truthful about the independent-human gate.
- Following the owner's explicit rollout direction, make the selected hybrid plus pinned reranker strategy the runtime default whenever RAG retrieval is enabled; fail startup closed when its private authenticated endpoint does not satisfy the evaluated model and token bounds.
- Preserve every `PENDING` human-review decision and the untouched holdout as unresolved evidence; do not present the owner's rollout authorization as independent review.
- Drive the runtime wiring and portable local AMD contract through a red-green loop, run the full affected verification, and promote only the exact green SHA to `dev`.

### Conditional checkpoint

The repository owner approves the human decision gate green without reservations through 2026-08-15 23:59:59 Europe/Warsaw. The untouched holdout and exact evidence remain enforced.

### Progress

The approved 19-file allowlist is refrozen at snapshot `2994f809649d3dd155faf09419557de7af70c7a77dae9aa4d3cf67f717ac70a8`; the v3 packet expands only train/dev to 42 balanced PL/EN exact-ID, multi-document, no-hit and ACL cases while preserving all six v2 holdout records semantically unchanged. Train-only selection chose document-diverse fielded BM25/RRF plus the revision-pinned `BAAI/bge-reranker-v2-m3`, bounded to 20 candidates and 192 tokens. The clean exact-SHA local MongoDB/Qdrant/private-ROCm comparison passes the proposed non-holdout gates: Recall@5 `0.9107`, MRR@5 `0.8048`, PL `0.8929`/`0.8000`, EN `0.9286`/`0.8095`, no-answer `1.0`, p95 `231.83 ms`, and zero duplicate, forbidden, stale or isolation hits. ROCm 7.2 on `gfx1151` served the pinned reranker over loopback-only vLLM; the temporary service and isolated stores were removed after evaluation. Dense remains the runtime default and holdout remains unobserved because `human-review-v3.json` still has 42 truthful `PENDING` decisions; independent human review is the only remaining gate before final holdout and promotion.

The owner subsequently authorized the exact selected strategy as the default before independent review and holdout. Runtime now composes canonical dense plus fielded BM25 with the evaluated RRF weights and an authenticated private reranker that verifies the exact served model/revision and 192-token bound at startup; `dense-v1` is an explicit rollback and never an automatic fallback. A separate digest-pinned `reranker-amd` service can move independently and keeps its model cache on the workspace filesystem. Red-green tests prove typed classifier fallback for analysis, HTTP 503 for search and no dense substitution on reranker failure. Full `make verify` passes, including 611 backend-AI tests with the frozen holdout checks, 240 Node tests, 21 BDD scenarios/107 steps, 175 web tests plus 2 integrations, 192 mobile tests, 50 MCP tests, dependency audits, typecheck and pylint `10.00/10`. The 42 independent decisions remain `PENDING`, holdout remains unobserved, and no deployment or production approval is claimed.
---

## TASK-013: Approve representative retrieval quality gates
**Priority:** P1 | **Tags:** rag, evaluation, recall, mrr, human-gate

Build a human-reviewed PL/EN retrieval golden set from the approved corpus and establish Recall@k, MRR, no-hit, duplicate, freshness, and isolation thresholds before tuning retrieval.

### Plan

- Freeze train/dev/holdout queries with relevant, forbidden, stale, and deleted document labels.
- Run the existing evaluator against the real Qdrant candidate and report required slices.
- Validate the independent review as a hash-bound, fail-closed attestation, preserve crash-recoverable immutable outputs, and confirm human provenance out of band.
- Obtain human approval for thresholds and preserve the immutable dataset/report hashes.

### Resume gate

Synthetic fixtures remain smoke tests; representative relevance labels and final thresholds require human review after TASK-010 through TASK-012.

### Conditional checkpoint

The repository owner approves the frozen proposed relevance decisions and threshold work green without reservations through 2026-08-15 23:59:59 Europe/Warsaw. Comparison and selection may proceed now while the untouched holdout and immutable hashes remain enforced.

### Progress

After the approved security/index documentation changed, the same 19-file corpus allowlist was owner-refrozen and every dependent candidate/runtime hash was regenerated before human review. The untuned real MiniLM + canonical MongoDB + Qdrant baseline still fails: Recall@5 `0.6667`, MRR@5 `0.5444`, no-answer accuracy `0.9444`, PL Recall@5/MRR@5 `0.4375`/`0.4375`; isolation, forbidden, stale and duplicate hit rates were zero. The readable worksheet maps every case to proposed sources, while `human-review-v1.json` is the authoritative four-hash-bound record with 18 pending decisions. A tested single-read finalizer re-verifies the physical corpus, rejects incomplete/drifted/duplicate/security-relaxed review, and creates staged, crash-recoverable attestation outputs without overwriting conflicting evidence. It explicitly records that human provenance is not cryptographically verified and remains an out-of-band gate. Fresh backend regression is `365 passed, 7 skipped` at `89.86%` coverage and focused review-finalizer coverage is `15 passed`; no human judgment has been fabricated and holdout results were not used for tuning.

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
