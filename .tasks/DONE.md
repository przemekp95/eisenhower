# Done

## TASK-040: Stabilize the language switcher accessibility gate
**Priority:** P1 | **Tags:** accessibility, e2e, web, release-gate

Restore the exact-head E2E accessibility gate by giving the active language control durable WCAG contrast and ensuring automated scans observe the settled intro state rather than an in-flight opacity transition.

### Plan

- Replace the threshold-level active language color with a token that has a safe contrast margin on the rendered light background.
- Synchronize Axe scans with the semantic `data-app-intro=ready` application state without sleeps or disabled rules.
- Verify focused web tests and Playwright, then promote the isolated fix through a green PR to `dev` before rebasing the shadow-classifier candidate.

### Outcome

Replaced the threshold-level active language token with `text-blue-800`, made the reduced-motion path always settle a pending intro, and bound reduced-motion explicitly in both Playwright projects before waiting on the semantic intro-ready state for Axe. PR #161 reproduced a 3.47:1 contrast violation across all retries, while the first PR #162 run proved the project-level device settings had overridden the top-level reduced-motion option; both root causes are covered without disabling accessibility rules or adding sleeps.

---

## TASK-038: Add deterministic change-impact CI planning
**Priority:** P1 | **Tags:** ci, reliability, performance, security

Reduce pull-request CI cost with a versioned, fail-closed impact plan while preserving stable required checks and full release-quality coverage for risky or unknown changes.

### Plan

- Add a deterministic merge-base and changed-path planner with rename/delete, manifest, workflow, root, infrastructure and dependency-graph handling plus multi-label reasons and an input digest.
- Keep every required context successful through explicit not-applicable paths, while forcing full CI for `master`, release, schedules, workflows, lockfiles, infrastructure, unknown inputs and planner errors.
- Add focused red-green planner/rules tests, actionlint and missing n8n/MCP/API-client checks; optimize safe setup/cache paths and document measured baseline boundaries.
- Coordinate sync, release, production-acceptance and ruleset contracts, then run fresh local verification and update the existing PR to `dev` without merging or touching production.

### Outcome

Added a versioned, merge-base-driven and fail-closed impact planner with rename/delete handling, dependency propagation, canonical input digests and explicit reasons. Stable required jobs now fail visibly when resolution fails, otherwise report an explicit not-applicable success; security audits and Trivy remain continuous, while full CI is forced for release-risk inputs. Planner/actionlint contracts, n8n/MCP/API-client coverage, caches and coordinated workflow documentation are included. Fresh local `make verify`, focused security/planner checks and the full PR CI run `31544533146` passed on `872ea7463a58dd039124473464cb9016334502ce`; PR #159 remains unmerged.

---

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

### Outcome

Hardened canonical MongoDB/Qdrant retrieval and reconciliation, durable webhook/job ordering, mobile and Node idempotency/HTTP/configuration/readiness contracts, the bounded Mongoose repository seam, SDK/MCP runtime validation, shared contract fixtures, web request behavior, immutable release inputs and architecture/methodology documentation. Cleared the historical Python and workflow lint debt, made Pylint a 10.00/10 gate, and replaced the PyTorch audit blind spot with exact source/version/hash/vulnerability checks while keeping research-only dependencies isolated. Full local `make verify`, six Playwright checks, Compose/nginx/actionlint validation and all PR checks passed. PR #157 merged to `dev` as `73c984066cfd65ffce0a4fc31f041ba7c24eded2`; the full post-merge CI on that exact SHA also passed. `master`, production, runtime feature flags and human/physical gates were unchanged.

---

## TASK-036: Add a fail-closed AI promotion controller
**Priority:** P1 | **Tags:** ai, promotion, shadow, canary, rollback

Implement a reversible controller for independently governed retrieval, generation, response and MAG phases. Require immutable candidates, explicit approvals and green quality/drift evidence before shadow or canary pointer changes, with stable assignment, stop conditions and rollback.

### Plan

- Add red state-machine tests for illegal transitions, missing or stale evidence, phase dependencies, canary assignment and rollback.
- Keep candidate artifacts immutable and write only auditable atomic pointers; never enable a phase merely because another phase starts.
- Provide local dry-run and CI contract checks while leaving production traffic, owner approvals and deployment as explicit resume gates.

### Outcome

Added a locked atomic pointer state machine for independently governed retrieval, generation, response and MAG phases with legal `disabled -> shadow -> canary -> enabled` progression, dependency gates, bounded stable pseudonymous canary assignment, immutable-candidate verification, fresh checksummed green quality evidence and matching approval receipts. Each applied transition preserves a private rollback pointer; dry-run is the CLI default and `--apply` changes only local state, never runtime flags or deployment. TDD evidence: the test first failed on the absent controller; three fixtures then exposed their own invalid shadow percentages without weakening the implementation. Green evidence is 17 promotion/monitoring tests and pylint 10.00/10. No production approval, flag change, traffic assignment or deployment occurred.

---

## TASK-035: Add quality and drift monitoring reports
**Priority:** P1 | **Tags:** ai, monitoring, drift, observability

Produce privacy-safe, checksummed periodic quality and drift reports for classifier, retrieval, generation, response and MAG phases without logging prompts, PII, tokens or private identifiers.

### Plan

- Add red tests for baseline comparison, slice drift, missing evidence, sensitive-label rejection and fail-closed status.
- Reuse aggregate metrics while keeping offline quality reports distinct from runtime SLO telemetry.
- Register reports in the shared lineage manifest and expose only bounded status/metrics needed by promotion decisions.

### Outcome

Added a checksummed aggregate-only quality/drift report for classifier, retrieval, generation, response and MAG. Missing phases, samples, metric drift or slice drift block the report; recursive field validation rejects prompt, token, content, citation, PII and private-identifier keys before serialization. Reports record only counts/deltas and can be registered as monitoring lineage without retaining raw snapshots or collection IDs. TDD evidence: tests first failed on the absent monitoring module and later absent registrar; green evidence is 12 monitoring/metrics tests and pylint 10.00/10. This is offline quality evidence, not deployed telemetry or an invented production SLO.

---

## TASK-034: Automate the LLMOps candidate workflow
**Priority:** P1 | **Tags:** ai, llmops, prompts, evaluation

Build a candidate-only workflow for immutable PromptSpec checksums, schema and token budgets, PL/EN golden, safety and structured-output evaluation, regression comparison and candidate registration. Mock or in-process results must be labelled and must never satisfy a live-model gate.

### Plan

- Add red contracts for prompt/schema/runtime lineage, required PL/EN and safety slices, regression policy and evidence-level separation.
- Reuse the prompt registry, renderer, validators and regression gate to create a deterministic offline candidate command and CI job.
- Keep model/tokenizer/GPU/license selection, live vLLM and champion promotion fail-closed.

### Outcome

Added a candidate-only LLMOps workflow that checksum-validates PL/EN PromptSpecs and token budgets, binds the JSON Schema, golden/adversarial cases and independently frozen mock outputs, then executes schema, citation-safety and regression comparisons without a model. It registers a checksummed `ci_in_process` contract candidate and explicitly records `live_model.executed=false`; this does not satisfy live-model quality. TDD evidence includes fail-closed registrar tests and a regression caused by changing a frozen mock output. Model/GPU/license selection, real live-model evaluation, durable private CI storage and promotion remain open.

---

## TASK-033: Automate the RAGOps candidate workflow
**Priority:** P1 | **Tags:** ai, ragops, ingestion, qdrant, recovery

Compose the approved corpus manifest, governed extraction, canonical MongoDB, versioned Qdrant, reconciliation, evaluation and snapshot/restore primitives into one checksummed candidate workflow. Candidate creation must never promote the live alias automatically.

### Plan

- Add red contracts for immutable lineage, canonical-before-vector ordering, reconciliation, snapshot verification and absence of alias promotion.
- Reuse existing ingestion, collection and evaluation components behind an explicit candidate command and CI-local smoke profile.
- Register reports and recovery evidence while keeping real services, representative review and deployment as explicit external gates.

### Outcome

Added a RAGOps candidate registrar that requires canonical-before-vector ordering, zero reconciliation drift, evaluated retrieval, a checksummed isolated snapshot/restore proof, Mongo/Qdrant runtime identity and an explicitly unpromoted alias. It registers corpus, golden set, encoder, canonical schema, versioned collection receipt, snapshot and report in the shared immutable registry; it cannot switch an alias. A CLI accepts only freshly produced report/snapshot inputs and fails closed rather than rebinding stale evidence. TDD evidence: the focused slice first failed on the missing registrar; green evidence is 30 focused/RAG regression tests with one opt-in live-runtime skip and pylint 10.00/10. Representative TASK-013 review, target runtime and deployment remain external gates.

---

## TASK-032: Automate the MLOps candidate workflow
**Priority:** P1 | **Tags:** ai, mlops, training, evaluation

Build a deterministic candidate-only workflow for data validation, leakage and required slices, multi-seed training, incumbent/baseline comparison, thresholds and checksummed artifact registration. Human-approved production evaluation and promotion remain fail-closed.

### Plan

- Drive the workflow with red contract tests and reuse the existing evaluation, benchmark and atomic model-generation components.
- Separate candidate creation from any current/champion pointer change and record seeds, dataset, encoder, code and report lineage.
- Add a local command and CI job that produces private immutable artifacts without fabricating TASK-001 or TASK-002 evidence.

### Outcome

Composed the existing deterministic grouped-CV, five-seed training, leakage, PL/EN slices, centroid baseline, incumbent and threshold report into a candidate-only registry workflow. It records training/evaluation data, encoder receipt, schema, runtime, Git and report lineage, requires the development gate to pass, preserves a failed human/production gate in the report, and proves the current model pointer is unchanged. CI builds the private registry only in runner-local storage and uploads a checksummed allowlisted public commitment, never full lineage or blobs; durable private CI storage remains an external owner gate. No human annotation, production approval or model promotion was performed.

---

## TASK-031: Add an immutable AI artifact registry and lineage manifest
**Priority:** P1 | **Tags:** ai, mlops, ragops, llmops, lineage

Create one dependency-light, immutable candidate manifest that binds Git SHA, datasets, encoder/model revisions, prompt/schema, corpus/Qdrant state, runtime identity and reports by checksum. Store candidates privately without overwrite or delete semantics and keep promotion pointers separate and reversible.

### Plan

- Add red contract tests for canonical serialization, checksums, complete typed lineage, immutability, conflict rejection and private filesystem storage.
- Implement a project-owned manifest/registry and CLI that can register and verify candidates without introducing MLflow or a new service.
- Integrate the registry contract with later MLOps, RAGOps and LLMOps workflows while keeping promotion outside candidate creation.
- Run focused and broader local verification and record exact artifact boundaries.

### Outcome

Added a strict checksummed `ai-candidate-v1` lineage contract with explicit applicable/not-applicable groups for datasets, model/encoder, prompts, schemas, corpus, Qdrant, runtime and reports. Added a private filesystem registry with content-addressed blobs, `0700` directories, `0600` files, exclusive creation, idempotent identical registration, conflict/tamper detection and no delete or promotion operation, plus a register/verify CLI. No MLflow or persistent service was introduced. TDD evidence: the collected test first failed because `app.artifacts` did not exist; the CLI slice separately failed on the missing CLI module. Green evidence: 5 focused tests and 45 artifact/prompt/model/evaluation tests passed, and pylint rated the new modules 10.00/10.
## TASK-030: Promote executable BDD to green dev
**Priority:** P1 | **Tags:** bdd, delivery, dev, ci

Publish the completed TASK-029 BDD package through a pull request to `dev`, require every repository check to pass, merge only after green CI, and verify the resulting remote `dev` commit. Do not modify `master` or deploy production.

### Plan

- Commit only the intended BDD, documentation, CI, and TaskPlanner changes on a dedicated branch.
- Integrate the latest `origin/dev` without losing or stashing the dirty worktree, then rerun release-level local verification.
- Push the branch, open a detailed PR to `dev`, and wait for all required checks before merging.
- Close the TaskPlanner promotion state through a follow-up PR if necessary and independently verify the final `origin/dev` SHA.

### Outcome

Reconciled the local package with PR #153 without stash or data loss, renumbered the colliding local tasks to TASK-029/TASK-030, and reran the complete local release-quality gate. Green PR #154 passed branch policy, security/Trivy, Node including 15 BDD scenarios/59 steps, frontend unit/integration/Playwright, backend AI, mobile and native Android checks, then merged to `dev` as `0721ca8f2edbeb4216622f315b23d62119cb5d83`. The remote merge SHA was fetched and verified before this follow-up state update. `master` and production were not changed.

---

## TASK-029: Add executable BDD for task behavior
**Priority:** P2 | **Tags:** testing, bdd, cucumber, backend-node

Add a real executable Gherkin workflow for the user-visible task lifecycle without relabeling ordinary Jest tests as BDD.

### Plan

- Preserve the existing seven lifecycle/quadrant scenarios and typed Express/Supertest/Mongo harness.
- Add bounded living scenarios for bearer authentication, trusted browser origins, request validation, and missing-resource behavior.
- Keep unit-level edge cases, experimental AI/RAG, messaging, and physical-device acceptance outside this BDD slice.
- Run focused BDD/backend verification and the complete root release-quality gate, then update the documented evidence boundary.

### Outcome

Added a Node 20/24-compatible Cucumber 12.9 executable acceptance layer with typed TypeScript steps driving the real Express app through Supertest and isolated MongoDB. Fifteen Gherkin scenarios and 59 steps now cover all four canonical quadrants, task movement/deletion, tenant isolation, missing and invalid bearer credentials, trusted and untrusted browser origins, title limits, unexpected-field rejection, and missing-resource behavior. The harness pins and restores auth/OIDC/CORS environment state and passed with deliberately hostile inherited variables. Added `test:bdd` and `make test-bdd`, included BDD in root test/verify and the existing backend CI job, and documented that this is a bounded living-behavior slice rather than repository-wide BDD, DDD, CQRS, hexagonal architecture, or historical TDD evidence. After integrating current `origin/dev`, fresh `make verify` passed production audits, Node 87 tests at 100% plus BDD 15/15, web 150 at 100% plus 2 integration tests, backend AI 419 with 6 opt-in skips at 89.44% coverage, and mobile 115 tests; `actionlint` and YAML parsing also passed.

---

## TASK-024: Harden supported task runtime and client reliability contracts
**Priority:** P0 | **Tags:** production, auth, tasks, web, mobile, reliability

Implemented the safely decidable engineering and functional remediations from the fresh read-only audit without deploying, publishing, weakening gates, or implying multi-user production readiness.

### Plan

- Prove and fix the exact Mikrus static-auth runtime contract and Node AI readiness timeout behavior.
- Preserve failed web drafts and accurate partial import/feedback behavior; split user/admin credentials, add logout, OCR review/consent, destructive confirmations, and accessible interaction contracts.
- Add mobile reconnect/retry, honest sync states, logout, OCR review/consent, destructive confirmations, and regression coverage.
- Enforce owner-scoped OIDC task access, optimistic concurrency, backward-compatible pagination, and a supporting database index.
- Bound or renew experimental job leases, align monitoring with the real topology, and add focused multi-worker/alert coverage.
- Record strict red-green evidence, run focused checks, full `make verify`, Playwright E2E, Compose/runtime smoke, and document architecture/security/methodology conclusions.

### Outcome

Mikrus now renders and boots the supported static single-tenant contract, while Node readiness uses `/health/ready` with a bounded abort timeout. OIDC task reads and writes are owner-scoped inside the tenant; revision ETags, optional `If-Match` conflicts, cursor pagination and the compound owner/sort index preserve legacy clients while updated web/mobile clients use guarded writes. Web and mobile now separate access/admin credentials, retain failed drafts and pending work, expose logout/recredential, provide editable/selected OCR review with independent feedback consent, report partial persistence honestly, localize changed accessibility surfaces, confirm destructive actions and distinguish quadrant Delete from physical deletion. Playwright now includes a WCAG A/AA axe gate on desktop and mobile. Mobile additionally retries on refresh, foreground and network recovery, and exposes explicit conflict resolution against the fresh server revision.

The experimental SQLite worker renews long leases and durable heartbeats, refuses acknowledgement after renewal loss, and has multi-worker coverage. Prometheus now scrapes the real optional inference target and gates inference/worker alerts on configured runtimes; `promtool` validated the config and all 9 rules. Schedule reminders, Delegate workflow, lifecycle states and RAG/camera parity remain separate TASK-025 through TASK-028 product decisions.

TDD evidence was recorded from failing contracts for Compose boot, readiness timeout/unready, owner isolation/concurrency/pagination, web/mobile mutations and OCR, reconnect/conflicts, worker lease/heartbeat and topology-gated alerts, followed by focused green runs. Final local verification: `make verify` passed Node 87/87 at 100% coverage, web 150/150 at 100% plus 2 integration tests, backend AI 415 passed/7 skipped at 89.40%, and mobile 115/115 above every coverage threshold. Playwright passed 6/6 desktop/mobile checks; the exact rendered Mikrus environment passed 19 focused deployment/readiness tests and the Node production config loader; system `pytest 7.4.4` is installed. No deployment, public runtime, physical-device, live inference, n8n/job/webhook production, commit, push or PR evidence is claimed.
---

## TASK-022: Implement a portable private generation boundary
**Priority:** P2 | **Tags:** rag, generation, gpu, portability, security

Implement the locally verifiable vendor-neutral FastAPI-to-`GenerationProvider` boundary for a fixed private OpenAI-compatible inference endpoint without assuming GPU colocation or vendor. Preserve application-owned auth, ACL, retrieval, prompt construction, validation, citations, fallback and all three RAG gates.

### Plan

- Add red contract and failure tests for NVIDIA/CUDA versus AMD/ROCm and local versus remote endpoint invariance, plus unavailable, timeout, 429/5xx, disconnect and invalid structured output.
- Harden the fixed private endpoint, service authentication, secrets, bounded phase timeouts, circuit breaker, health/metrics reporting and safe classifier fallback.
- Separate neutral base configuration from disabled opt-in NVIDIA/CUDA and AMD/ROCm vLLM profiles without publishing the inference port.
- Report CUDA, ROCm, MPS, CPU and other supported runtimes honestly, and document the hardware/runtime/model/quantization matrix plus exact live gates.
- Run focused and full local verification while keeping every live GPU, vLLM, performance, VRAM, OOM and production claim explicitly open.

### Resume gate

Local contracts, configuration, profiles and mock transport verification may proceed now. Enabling generated responses or declaring hardware compatibility remains governed by TASK-015 and TASK-023.

### Outcome

Replaced the application-level vLLM naming/configuration with a vendor-neutral private OpenAI-compatible adapter while keeping the compatibility input, all RAG flags, FastAPI auth/ACL/prompt/validation/citation ownership and classifier fallback. Added explicit private-host allowlisting, service auth, phase timeouts, bounded failure reasons, a concurrency-safe single-probe circuit breaker, optional readiness/Prometheus circuit reporting and honest CUDA/ROCm/XPU/MPS/CPU detection. Removed the NVIDIA FastAPI image and common CUDA settings, then added separate disabled NVIDIA and AMD vLLM profiles with no host port and no default service secret. Documented local/remote topology, the evidence-bound hardware/runtime/model/quantization matrix and exact live gates. TDD evidence: the first focused run failed at collection for the missing neutral provider; the profile contract then failed 2/2 before the files existed. Green evidence: focused Python 102/102, profile 2/2, Node deployment 7/7, both Compose renders, changed Python pylint 10.00/10, and full `make verify` passed Node 66, web 135 plus 2 integration, backend AI 414 with 6 opt-in skips at 89.46% coverage, and mobile 95. No live vLLM, selected model, CUDA/ROCm inference, performance, VRAM, OOM, deployment or production claim is made.

---

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
