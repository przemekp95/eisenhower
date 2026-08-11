# Done

## TASK-021: Enforce grounded information-delta responses
**Priority:** P1 | **Tags:** rag, generation, novelty, grounding, evaluation

Add a fail-closed contract that compares generated claims with explicit known state or prior-output facts and distinguishes grounded new information, confirmation, contradiction/update, necessary reminders, and honest no-new-information. A frozen corpus proves only source-relative delta, never current-world freshness.

### Plan

- Add bounded untrusted known-state input and a structured information-delta output without introducing implicit history or autonomous memory writes.
- Validate claim relations, known references, allowed citations, semantic near-duplicates and world-freshness scope deterministically; reject fabricated novelty and invalid deltas.
- Expose validated delta metadata only on the existing guarded RAG response path, while keeping fallback, TASK-013, vLLM and MAG rollout gates unchanged.
- Add PL/EN evaluation metrics and regression tests for paraphrases, repetition, contradictions, updates, necessary reminders, no-new-information and prompt injection.
- Verify source, tests and local in-process reachability separately from live vLLM, deployment and public evidence.

### Resume gate

Local schema, validation and in-process contract tests may proceed independently. Live generation, response canary and MAG augmentation remain blocked by TASK-013 through TASK-015 and their human/deployment gates.

### Outcome

Added checksummed, bounded and explicitly untrusted known-state/previous-output input plus a strict information-delta schema for new information, confirmations, contradictions, updates, necessary reminders, honest no-new-information and frozen-corpus freshness abstention. The application layer now enforces known-reference validity, allowed citations, citation support, semantic repetition and claim deduplication through a versioned similarity port wired to the pinned retrieval MiniLM; prompt text alone is not treated as enforcement. Invalid deltas fail closed to the bounded fallback, current-world requests abstain without generation, model prose is not surfaced for delta responses, and MAG remains a separate consent-governed domain with no implicit history writes. Added PL/EN quality/safety metrics, adversarial tests and a mocked private-vLLM strict-schema transport test. Fresh verification passed 385 backend tests with 7 opt-in runtime skips at 89.28% coverage, changed modules scored pylint 10.00/10, PromptSpec 1.1.0 checksums passed and diff hygiene passed. This proves source, tests and local in-process/mock-HTTP reachability only; the candidate PromptSpec still intentionally lacks an approved model/tokenizer, local MiniLM weights were not fetched, and no live vLLM, deployment, canary or public evidence is claimed. TASK-013 through TASK-015 and MAG rollout gates remain unchanged.

---

## TASK-012: Prove Qdrant isolation, reindex, backup, and rollback
**Priority:** P1 | **Tags:** rag, qdrant, integration, recovery

Run production-like Qdrant integration tests for tenant/project/ACL isolation, tombstones, versioned collections, alias cutover, snapshots, restore, and rollback using the approved corpus contract.

### Plan

- Exercise a real Qdrant service rather than only mocks or in-memory client mode.
- Verify cross-tenant/project denial, stale-content removal, snapshot checksums, isolated restore, and alias rollback.
- Record exact Qdrant version, commands, artifact hashes, timings, and retained previous collection.

### Outcome

Hardened the Qdrant projection so replacement and privacy tombstones physically delete tenant/document points instead of retaining private text and vectors behind a flag, and made projection inspection paginate beyond 10,000 points. Added guarded alias transitions with expected-current and postcondition checks plus snapshot metadata, uploaded restore and cleanup operations. The real loopback Qdrant 1.12.0 rehearsal proved tenant/project/ACL denial, zero stale/tombstoned/orphan points, a 768,512-byte snapshot whose server checksum matched independently downloaded SHA-256 `daa09e4deb7b14fcbbae0fa6e30de8ca60723ff8e7be824cb3a7445959f7af3a`, isolated restore with an identical collection digest, atomic alias cutover, retained previous collection and rollback without resurrecting the propagated tombstone. Snapshot and isolated collections were cleaned up. The live recovery test passed 1/1, the full backend suite passed 299 with 5 opt-in skips at 89.57% coverage, and changed modules scored pylint 10.00/10. This is production-like local-container recovery evidence, not a target-environment or production rehearsal.

---

## TASK-018: Add governed Docling and Unstructured document extraction
**Priority:** P1 | **Tags:** rag, ingestion, docling, unstructured, documents

Implemented Docling as the primary document parser and Unstructured as a bounded fallback behind a project-owned extraction port for the document formats approved in the first RAG corpus. Preserve provenance and fail closed on unapproved, unsafe or ambiguous input.

### Plan

- Define a `DocumentExtractor` contract and source-specific normalized result without leaking framework types into application/domain code.
- Add allowlisted size/media/extension checks, resource budgets and negative fixtures for archives, encrypted/malformed files, embedded content, prompt injection and unsupported formats.
- Preserve headings, lists, tables, page/source spans, checksums, extraction version and OCR provenance for deterministic chunking and deletion/reindex.
- Benchmark Docling primary output and Unstructured fallback on reviewed PL/EN golden documents; record quality, latency, memory, rejection and exact-version evidence.
- Connect only the approved document source to TASK-011's canonical document store, reconciliation and privacy-deletion lifecycle.

### Outcome

Added strict project-owned inspection, policy, extraction and ingestion contracts for approved local PDF/DOCX/PPTX/HTML sources. Docling 2.119.0 uses the immutable `docling-layout-heron-onnx` revision on ONNX Runtime CPU; Unstructured 0.25.2 runs only for the two approved quality/layout reasons, while security, resource and programming failures remain fail-closed. OCR requires a receipt frozen in the corpus manifest and records the exact checksum, PL/EN scope, Tesseract CLI 5.3.4 provenance and human approval ID. The offline benchmark passed 11 runtime cases: five formats through both parsers plus owner-approved image-only PDF OCR, with required text present and exact dependency/model evidence. A real local MongoDB/Qdrant integration passed all six approved fixtures through canonical persistence and projection with zero reconciliation drift. Focused tests passed 49/49, the live integration passed 1/1, the full backend suite passed 298 with 4 opt-in skips at 89.83% coverage, changed modules scored pylint 10.00/10, and dependencies passed `pip check`. This proves local code, tests and local runtime only; deployment and public evidence remain absent.

---

## TASK-011: Complete the canonical RAG ingestion contract
**Priority:** P1 | **Tags:** rag, ingestion, data-integrity

Implemented the approved source connector and canonical document lifecycle with deterministic source-specific normalization, schema/chunking versions, project metadata, reconciliation, reindex, and privacy deletion semantics.

### Plan

- Add red contract tests for normalization, versions, stale updates, deletes, and source boundaries.
- Implement the frozen manifest loader and allowlisted repository/document connector without generic URL fetching.
- Persist canonical documents in MongoDB before vector writes, with monotonic source sequences, tombstones and privacy-safe deletion.
- Implement reconciliation and a real project reindex handler without widening the existing signed job allowlist.
- Verify focused tests, full backend-AI regression, static analysis, manifest integrity and TaskPlanner uniqueness.

### Outcome

- Bound repository reindex to the frozen manifest version/checksum, approved tenant/project and fixed owner identity; added the 19-file frozen snapshot plus six allowlisted incremental TaskPlanner Markdown sources.
- Made MongoDB the canonical version authority before Qdrant projection, with monotonic writes, exact-revision completion, conflict detection, tombstone redaction, pending reconciliation and projection read-back by chunk ID/checksum/content version.
- Added forced full-project rebuild after Qdrant collection loss, fail-closed private Mongo validation/startup ping, exact queue idempotency conflicts and an unchanged four-command job allowlist.
- Verified real local MongoDB 7 and Qdrant 1.12 runtime: 25 canonical documents produced 155 active chunks, forced rebuild completed 25/25 with zero pending and reconciliation reported zero drift; an independent collection-loss integration test also passed.
- Full backend-AI verification passed with 249 tests, 3 opt-in skips and 89.82% coverage; changed application modules scored pylint 10.00/10 and `git diff --check` passed. This is local runtime evidence, not deployment or public evidence.

---

## TASK-010: Approve the first RAG corpus and privacy manifest
**Priority:** P1 | **Tags:** rag, corpus, privacy, human-gate

Choose the first canonical knowledge sources and record ownership, tenant/project ACL derivation, provenance, retention, deletion, PII handling, source connector, and explicit exclusions before any real user content is indexed.

### Plan

- Select the smallest product use case where project context measurably improves prioritization.
- Prepare an exact owner decision packet covering sources, formats, ACL, provenance, PII, retention, deletion, OCR, connector and explicit exclusions.
- Complete the corpus manifest and privacy/retention decisions with the responsible human owners.
- Approve a synthetic-to-real-data transition and keep unapproved sources fail-closed.

### Resume gate

Requires explicit user/data-owner decisions; Codex must not infer consent to index tasks, notes, calendars, chats, email, OCR, or history.

### Outcome

Recorded the repository owner's explicit full-scope approval and froze `eisenhower-corpus-v1`: 19 project documents in the immutable initial snapshot, versioned TaskPlanner sources, and governed PDF/DOCX/PPTX/HTML inputs. Approved Docling primary extraction, deterministic Unstructured fallback, PL/EN OCR with mandatory human review, MongoDB-before-Qdrant persistence, ACL derivation, PII/secret rejection, retention/deletion and explicit exclusions. The parser contract was re-frozen with explicit 500-page, 120-second, 4-GiB peak-memory and 20-character primary-quality limits, an immutable Docling 2.119.0 ONNX CPU layout runtime/model revision, and a checksum-bound owner receipt for the synthetic OCR fixture. After the approved documentation itself changed, the same 19-file allowlist was owner-refrozen on 2026-08-11 rather than bypassing snapshot validation: source snapshot SHA-256 `7d52fdd5f973f62a19f3c67a1afcfbe3d4990d80c75439e550b34f5d6188dd43`, manifest SHA-256 `b022333de73442927099881fdb4e327d7edea0feb1eba9ad809511e9ccec9f5f`. Deployment and publication remain unauthorized.

---

## TASK-017: Record the recruiter-aligned AI delivery plan
**Priority:** P1 | **Tags:** documentation, ai, rag, mag, recruitment

Record the coherent AI portfolio scope selected from the reviewed technology graphics and current czyjesteldorado.pl market signals. Make Docling/Unstructured document extraction and consent-governed MAG explicit delivery commitments, while preserving honest implementation, runtime, and production evidence labels.

### Plan

- Add a recruiter-facing roadmap that distinguishes required capabilities, bounded supporting tools, and explicit non-goals.
- Update the canonical delivery roadmap and TaskPlanner continuation map.
- Create executable follow-up tasks for document extraction, MAG, and the public technical case study.
- Verify links, TaskPlanner uniqueness, Markdown formatting, and the final diff.

### Outcome

Added the recruiter-aligned AI delivery plan, made governed Docling/Unstructured extraction and consent-governed MAG committed P1 scope, and created TASK-018 through TASK-020 for extraction, MAG, and the public case study. Updated the canonical roadmap and index while preserving evidence levels and explicit non-goals. Verified Markdown links, unique TaskPlanner placement and IDs, configuration numbering, and a clean `git diff --check`.

---

## TASK-016: Promote retrieval-first RAG package to green dev
**Priority:** P0 | **Tags:** rag, delivery, dev, ci

Publish the completed retrieval-first RAG package through a pull request to `dev`, require the repository checks to pass, merge only after green CI, and verify the resulting remote `dev` commit. Do not modify `master` or deploy production.

### Plan

- Audit the intended diff and refresh the remote branch relationship.
- Run release-level local verification, commit the scoped changes, push the feature branch, and open a PR to `dev`.
- Resolve only failures caused by this package, merge after green CI, and verify the remote `dev` SHA.

### Outcome

Integrated the package with the latest `origin/dev`, passed the full local `make verify` gate, and merged green PR #148. GitHub checks passed for branch policy, run-mode resolution, Trivy/security lint, backend AI, backend Node, frontend unit/integration/E2E, mobile, and native Android APK. Remote `dev` was independently fetched and verified at merge commit `8a2277be524bed5ceeb8c089b64e6a239f9a2fff`. `master` and production were not changed; real corpus approval, live Qdrant recovery/evaluation, production shadow traffic, vLLM/model/GPU selection, and advanced RAG remain in TASK-010 through TASK-015.

---

## TASK-009: Establish the retrieval-first RAG delivery path
**Priority:** P1 | **Tags:** rag, qdrant, shadow, architecture

Make retrieval-only Qdrant and non-user-visible shadow retrieval independently operable before vLLM generation, then persist every remaining corpus, privacy, production, hardware, and advanced-RAG gate for later conversations.

### Plan

- Add failing contracts for retrieval-only startup and shadow analysis without generation or user-visible RAG output.
- Separate retrieval and generation feature flags and bootstrap boundaries while preserving bearer/ACL/fallback behavior.
- Verify focused and broad local suites plus Compose configuration.
- Record executable follow-up tasks and exact external decision gates for corpus approval, real-Qdrant evaluation/backup, shadow acceptance, vLLM, and deferred advanced RAG.

### Outcome

Implemented independent retrieval/generation/response flags with legacy compatibility, Qdrant-only bootstrap, aggregate shadow retrieval that preserves the user-visible MiniLM fallback, and explicit authorized project filtering. Added client/config/operations documentation and TASK-010 through TASK-015 for every external or later gate. TDD evidence: the focused slice first failed 10 tests for the missing contracts, then passed 21/21; final focused coverage passed 63/63, full backend-AI passed 211 with 2 opt-in live-vLLM tests skipped at 89.75% coverage, API client passed 3/3, pylint rated changed Python 10.00/10, and retrieval-only Compose rendered with Qdrant/worker but no vLLM service. No real corpus, live Qdrant recovery test, production shadow traffic, deployment, model/GPU selection, or vLLM execution is claimed.

---

## TASK-008: Add a reusable TaskPlanner workflow skill
**Priority:** P2 | **Tags:** tooling, taskplanner, codex

Create a globally discoverable Codex skill that applies the repository's `.tasks/config.json` state mapping and safe TaskPlanner lifecycle consistently.

### Plan

- Initialize a concise `taskplanner-workflow` skill with UI metadata.
- Define discovery, task selection, state transitions, planning, verification, and work-log rules.
- Validate the generated skill and record its installed path.

### Outcome

Installed `taskplanner-workflow` under the global Codex skills directory with discovery metadata and a complete safe task lifecycle. The bundled skill validator reported `Skill is valid!`.

---

## TASK-007: Record deferred advanced RAG decisions
**Priority:** P2 | **Tags:** documentation, rag, architecture

Document reranking, hybrid search, knowledge graphs, and agentic or multi-step RAG as deferred capabilities, including the evidence that should trigger reconsideration.

### Plan

- Add a future-decision register to the AI delivery roadmap.
- Define a measurable revisit trigger and acceptance evidence for each capability.
- Verify documentation formatting and preserve the active production priorities.

### Outcome

Added a deferred advanced RAG decision register with measurable revisit triggers, required adoption evidence, and an ADR gate for every capability. Verified with `git diff --check` and targeted documentation searches.

---
