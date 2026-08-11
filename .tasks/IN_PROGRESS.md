# In Progress

## TASK-037: Harden repository architecture and promote green dev
**Priority:** P1 | **Tags:** architecture, reliability, security, contracts, quality

Resolve the repository-wide architecture audit findings without introducing speculative framework layers, then promote the integrated result through a fully green PR to `dev`.

### Plan

- Make RAG retrieval canonical against MongoDB, close projection-reconciliation gaps, and make opt-in webhook ingestion durable and payload-bound.
- Make mobile task creation retry-safe end to end; harden Node HTTP semantics, trusted-proxy rate limiting, readiness, pagination, configuration, and repository boundaries where they reduce real coupling.
- Harden MCP redirect authorization, validate API-client runtime contracts, centralize shared quadrant semantics, and add the missing contract/typecheck/quality gates to CI.
- Remove web test warnings, correct stale architecture/methodology documentation, and pin release image inputs where an immutable supported digest is available.
- Integrate the independently verified slices, run the complete local quality/runtime gates, open a PR to `dev`, require all checks green, merge it, and verify the remote merge SHA.

### Scope boundaries

- Preserve the existing pragmatic layered architecture; do not add a generic base repository, full CQRS, or an ORM/ODM abstraction without a demonstrated boundary benefit.
- Do not modify `master`, deploy, publish, enable gated RAG/MAG/generation flags, or claim live production evidence.
- Keep independent-human and physical-device gates fail-closed; local and CI evidence do not satisfy them.

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

---
