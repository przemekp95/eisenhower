# Delivery roadmap, dependencies and go/no-go gates

Sizes are relative (`S`, `M`, `L`) and are not calendar estimates. They require team size, environment ownership and data-source decisions before conversion into dates. This file is a target roadmap, not the active backlog; current release work is tracked in `.tasks/`.

The supported production scope is currently frozen at MiniLM+MLP classification, local similarity, and Tesseract OCR. Local retrieval-first implementation and verification are authorized under TASK-009, but Qdrant deployment, real user-data ingestion, production shadow traffic, vLLM generation, n8n activation, remote MCP, a new IdP/OIDC rollout, and multi-tenant platform work remain behind their recorded gates. A local scaffold, merged source, passing mock test, or valid Compose rendering does not prove that any of those capabilities are deployed.

## Continuation map

TaskPlanner is the executable source of truth for future conversations:

| Task | State after TASK-009 | Resume condition |
| --- | --- | --- |
| TASK-001 through TASK-005 | P0 release path | Complete human evaluation, promotion, backup/rollback and physical acceptance without weakening their existing gates. |
| TASK-010 | First RAG corpus/privacy decision | Human owners approve the use case, sources, ACL, provenance, PII, retention and exclusions. |
| TASK-011 | Canonical ingestion and reindex | TASK-010 approved; implement only the selected connector and data contract. |
| TASK-012 | Real Qdrant isolation and recovery | Approved corpus contract and a real target-like Qdrant runtime are available. |
| TASK-013 | Representative Recall@k/MRR gate | Human-reviewed relevance data exists after the real-Qdrant path is stable. |
| TASK-014 | Retrieval-only production shadow | All P0 and TASK-010 through TASK-013 gates pass and deployment is explicitly authorized. |
| TASK-015 | Private vLLM and cited responses | Retrieval shadow proves value and hardware, model, license and privacy decisions are approved. |
| TASK-018 | Docling/Unstructured extraction | TASK-010 approves document sources/formats; output joins TASK-011's canonical lifecycle. |
| TASK-019 | Consent-governed MAG | Memory ownership/consent/retention is approved and the grounded RAG baseline is stable. |
| TASK-020 | Recruiter-facing case study | Publish only verified evidence from TASK-010 through TASK-019 and an explicitly authorized demo SHA. |

TASK-007 remains the decision record for reranking, hybrid search, knowledge graphs and agentic or
multi-step RAG. Do not create implementation work for them until its evidence trigger and ADR gate
are satisfied.

## Phase 0 — semantic truth and honest capabilities

Goal: prevent corrupted labels and false RAG claims from entering the corpus or API.

| Work | Size | Priority | Dependency | Risk | Acceptance |
| --- | --- | --- | --- | --- | --- |
| Canonicalize quadrant IDs/labels across backend, web, mobile, client and MCP | M | P0 | none | historic data/UI behavior changes | one shared truth-table suite passes everywhere |
| Inventory and migrate/quarantine stored quadrant 1/2 data | M | P0 | data owner/source list | silent training/index corruption | dry-run counts, reversible migration and sampled review |
| Deprecate misleading RAG/LangChain names and capability text | S | P0 | client compatibility decision | external client breakage | legacy endpoints hidden/deprecated; current classifier described truthfully |
| Repair or remove broken GPU target declaration | S | P0 | target hardware decision | unusable Compose profile | `docker compose config` and selected image target are valid |

**Go:** all semantic and migration tests pass; corpus export rejects ambiguous records; capability/API docs are truthful. **No-go:** any 1/2 ambiguity, destructive migration without backup/rollback, or legacy path still presented as real RAG.

## Phase 1 — secure application boundary and ports

Goal: establish FastAPI ownership, identity/scope, versioned response schemas and provider-independent use cases.

| Work | Size | Priority | Dependency | Risk | Acceptance |
| --- | --- | --- | --- | --- | --- |
| Finalize `AccessScope`, analysis/citation schema and port error contracts | M | P0 | Phase 0 language | leaky infrastructure types | unit/contract tests for every mode/error |
| Bearer/OIDC, CORS/Origin and admin/scope policy | M | P0 | chosen IdP/audience/origins | auth bypass or client outage | real JWKS tests, negative scope/Origin/CORS suite |
| API/client backward-compatible rollout | M | P1 | contract freeze | web/mobile mismatch | backend/client/web/mobile contract E2E |
| Request correlation, safe logging, size/time budgets | S | P1 | observability backend | PII logs or unbounded calls | security tests and baseline dashboard |

**Go:** auth, tenant/project scope, contracts and deterministic fallback pass end to end. **No-go:** static development identity used as an unreviewed multi-tenant production mechanism, missing audit/rate-limit plan, or client incompatibility.

## Phase 2 — corpus and Qdrant retrieval

Goal: build a rebuildable, ACL-filtered, versioned index without generation.

| Work | Size | Priority | Dependency | Risk | Acceptance |
| --- | --- | --- | --- | --- | --- |
| Approve sources, privacy/retention, canonical document store and envelope | M | P0 | user/legal decisions | over-indexing PII/history | corpus manifest and DPIA/privacy sign-off as applicable |
| Extract approved documents through Docling with bounded Unstructured fallback | L | P1 | approved formats and fixtures | parser exploits, lost structure, silent OCR/PII ingestion | allowlist/resource limits, deterministic PL/EN golden extraction, provenance and rejection evidence |
| Deterministic normalize/chunk/checksum/tombstone | M | P0 | source fixtures | duplicate/stale chunks | repeat-run IDs and ordering/tombstone tests |
| Qdrant collections, payload indexes, ACL retrieval and snapshots | L | P0 | target Qdrant runtime | tenant leak/data loss | real Qdrant isolation, backup/restore tests |
| Versioned reindex, golden evaluation and alias cutover/rollback | L | P0 | complete corpus + goldens | bad index promoted | manifest validation and rehearsed atomic rollback |

**Go:** real Qdrant Recall@k/MRR, ACL, tombstone, snapshot and alias gates pass. **No-go:** Qdrant is canonical storage, ACL is post-filtered, ambiguous semantic data remains, or rollback is untested.

## Phase 3 — private vLLM grounded generation

Goal: add cited structured generation behind a fallback and hardware gate.

| Work | Size | Priority | Dependency | Risk | Acceptance |
| --- | --- | --- | --- | --- | --- |
| Inventory GPU/VRAM/runtime and select licensed model | M | P0 | target environment | OOM/unsupported model/license | benchmark report on target hardware |
| Harden provider transport/auth/timeouts/circuit/health/metrics | M | P0 | private network + secrets | token leak/cascading failure | fake/live contract and fault tests |
| Prompt boundary, structured output and citation enforcement | M | P0 | Phase 2 retrieval | injection/hallucinated citations | adversarial groundedness/citation suite |
| Shadow/canary quality and latency evaluation | L | P0 | golden dataset + telemetry | worse quality/cost | agreed thresholds met by cohort |
| Optional reranker experiment | M | P2 | evidence retrieval misses target | unnecessary latency/complexity | adopted only if held-out gain justifies cost |

**Go:** hardware, license, security, citation, groundedness, no-answer, latency/capacity and fallback gates pass. **No-go:** public vLLM, arbitrary model selection, invalid citations accepted, or model chosen without target VRAM tests.

## Phase 4 — asynchronous n8n ingestion and jobs

Goal: automate allowlisted sources while keeping domain logic and online analysis in FastAPI.

| Work | Size | Priority | Dependency | Risk | Acceptance |
| --- | --- | --- | --- | --- | --- |
| Harden the locally wired signed webhook and durable idempotent enqueue for raw-body production verification | M | P0 | Phase 2 ingestion app | representation mismatch/replay/duplicate | raw-body, replay and duplicate contract tests |
| Implement and operate a worker that claims, executes, retries and completes queued jobs | L | P0 | ingestion application + runtime topology | permanently queued work/partial write | crash recovery, retry/dead-letter and source-to-index E2E |
| Activate reviewed source workflows and sanitized error path | M | P1 | credentials + source APIs | credential/PII leakage | import/runtime E2E and retention review |
| Reindex/evaluation workflows with named operations only | M | P1 | alias/eval API | arbitrary execution | allowlist and negative-schema tests |
| Assess regular versus queue mode | S/M | P2 | measured workload | premature Redis/worker ops | written capacity decision; queue mode only with evidence |

**Go:** source-to-citation E2E, idempotency, worker retry/dead-letter, replay, audit and rollback pass. **No-go:** no active queue consumer, n8n in `/analyze`, direct Qdrant writes, generic executor, trusted tenant fields, public admin UI, or unbounded execution retention.

## Phase 5 — read-only MCP

Goal: expose safe queries through a thin API adapter.

| Work | Size | Priority | Dependency | Risk | Acceptance |
| --- | --- | --- | --- | --- | --- |
| Verify six read-only tool contracts against public API | M | P1 | Phases 1–3 public contracts | fabricated/overbroad results | MCP/API contract E2E and citations preserved |
| Ship local stdio with scoped credential guidance | S | P1 | secret storage | token exposure | no secrets in args/logs; allowlist tests |
| Evaluate remote transport only if required | M | P2 | gateway/auth owner | Origin/confused deputy/rate abuse | MCP auth, TLS, Origin, audience, rate/audit tests |
| Design mutations separately | M | P3 | product approval | unintended changes | new ADR, confirmation/scopes/idempotency; not part of initial release |

**Go:** stdio read-only contracts/security pass. **No-go:** generic tools, direct infrastructure access or remote HTTP without its full security gate.

## Phase 6 — consent-governed Memory-Augmented Generation

Goal: add durable, user-controlled memory without mixing it with RAG knowledge or allowing the
model/orchestrator to invent consent.

| Work | Size | Priority | Dependency | Risk | Acceptance |
| --- | --- | --- | --- | --- | --- |
| Define the memory domain, consent, provenance, TTL, supersession and status contracts | M | P0 | product/privacy owners | unowned or undeletable personal data | reviewed schema, commands/queries and lifecycle tests |
| Implement explicit-confirmation memory mutations and export/delete | L | P0 | identity, audit and retention policy | silent writes or incomplete erasure | idempotent create/supersede/revoke/delete/export E2E and audit evidence |
| Build a separate Qdrant memory projection with MongoDB revalidation | L | P0 | stable RAG retrieval and canonical memory store | stale/poisoned/cross-user memory | hard scope/consent/expiry filters, source revalidation and rebuild test |
| Add bounded memory retrieval and RAG/context fusion | M | P1 | prompt budget and conflict policy | memory overrides current evidence | separate budgets/provenance, conflict surfacing and deterministic fallback |
| Evaluate and progressively enable MAG | L | P0 | representative corrections and telemetry | false memory, drift, privacy or cost regression | benefit, false-memory, stale/conflict, poisoning, isolation, deletion, latency and token gates |

**Go:** explicit consent and ownership exist; CRUD/export/delete and projection rebuild pass; every
retrieved memory is current and scope-valid; representative evaluation shows benefit without
breaching false-memory, privacy, latency or token gates. **No-go:** autonomous writes, silent
conflict resolution, classifier feedback relabeled as memory, mixed knowledge/memory storage,
irreversible deletion, or Qdrant treated as memory source of truth.

## Phase 7 — production readiness and progressive rollout

Goal: prove quality, availability, security and reversibility in the target environment.

| Work | Size | Priority | Dependency | Risk | Acceptance |
| --- | --- | --- | --- | --- | --- |
| SLOs, metrics/traces/audit, dashboards and alerts | L | P0 | real traffic baseline | blind failure/PII telemetry | signal review and alert drills |
| Load/failure/security/privacy testing | L | P0 | production-like stack | hidden capacity/isolation issues | signed reports and no open critical findings |
| Backup/restore, alias/app/feature-flag rollback runbooks | M | P0 | operational owners | unrecoverable rollout | timed rehearsals with evidence |
| Shadow -> internal -> canary -> cohorts -> GA | L | P0 | every earlier gate | user harm/cost | automatic hold/rollback thresholds maintained |

**Go:** all prior phase gates, target-environment evaluation and rehearsals pass with owners. **No-go:** “works locally” is the only evidence, missing incident/privacy process, unresolved critical security issue or rollback cannot be completed safely.

## Smallest first vertical slice

After Phase 0, use one synthetic tenant, one reviewed project-context document and one golden task:

1. authenticate a scoped caller;
2. deterministically chunk and embed the document;
3. write it to a disposable versioned Qdrant collection;
4. retrieve with tenant/project/ACL filters;
5. call a fake OpenAI-compatible generator returning one valid citation;
6. validate `POST /v2/ai/analyze` and the fallback when the generator times out;
7. query the same result through `knowledge_search` MCP over stdio;
8. tombstone/reindex and prove the citation disappears; repoint the alias to prove rollback.

This slice is small enough to diagnose yet crosses the critical security, corpus, retrieval, generation, citation, fallback and MCP boundaries. Replace the fake generator with the selected vLLM model only after the hardware gate.

## Explicit non-goals

- Agentic or multi-step RAG at the start.
- n8n Simple Vector Store as production storage.
- Public n8n, Qdrant or vLLM endpoints.
- Redis/queue mode, MinIO, Kafka or a service bus without measured need.
- A general n8n/MCP workflow executor, arbitrary URL fetch, shell or database tool.
- Full CQRS/event sourcing without demonstrated scale/consistency need.
- Blind indexing of full history, chats, mailboxes, attachments or unreviewed OCR.
- Autonomous memory writes, inferred consent, silent memory conflict resolution or a shared
  knowledge/memory collection. MAG remains required work through TASK-019, but only with its
  explicit user-control contract.
- A reranker before held-out retrieval evaluation establishes the need.
- Selecting a vLLM model from parameter count alone or calling a local check a deployment.

## Deferred advanced RAG decision register

The capabilities below are deferred, not rejected. Revisit them only after the single-step,
dense-retrieval RAG path has real corpus, quality, latency, security and operational evidence.
Do not add any of them merely to match a generic RAG feature checklist.

| Capability | Current decision | Revisit trigger | Evidence required before adoption |
| --- | --- | --- | --- |
| Reranking | Defer; preserve the current Qdrant score order apart from deterministic deduplication and per-document caps. | Held-out retrieval evaluation shows relevant chunks are usually retrieved but ranked too low for the context budget. | A reproducible dense-versus-reranked benchmark demonstrates an agreed Recall@k/MRR, groundedness or task-quality improvement that justifies added latency, capacity and operational complexity. |
| Hybrid search | Defer; keep dense semantic retrieval as the baseline. | Real queries containing identifiers, exact names, dates or domain keywords are repeatedly missed by dense retrieval. | A held-out dense-versus-hybrid benchmark covers PL/EN and exact-match cases, defines score fusion, preserves tenant/project/ACL filters and meets latency targets. |
| Knowledge graph | Defer; keep canonical documents, chunks and metadata as the knowledge model. | Product use cases require verified multi-hop relationships, dependency traversal or entity-centric explanations that document retrieval cannot answer reliably. | Approved ontology and ownership, deterministic entity/relation provenance, tenant isolation, update/deletion semantics, graph quality evaluation and backup/restore runbooks. |
| Agentic or multi-step RAG | Defer; keep one bounded retrieve-generate-validate request with deterministic fallback. | A concrete user workflow cannot be solved safely by single-step RAG and genuinely requires decomposition, iterative retrieval or allowlisted tool use. | Threat model, strict tool and data scopes, step/time/cost budgets, idempotency, audit trail, adversarial evaluation, human confirmation for consequential actions and reliable cancellation/fallback. |

Record a separate ADR before adopting any row. The ADR must cite the triggering production
evidence, compare the simplest viable alternatives and define rollout and rollback gates.

## Decisions required from the user/owners

1. Which sources are in scope first, who owns them, and which are canonical?
2. Which tenants/projects/users may search each source, and is cross-tenant support ever allowed?
3. What PII, confidential data, retention, deletion, residency and model-training restrictions apply?
4. What is the target environment: single host, private cloud/VPC, Kubernetes, managed services, or another topology?
5. What GPU vendor/model, driver/runtime, device count and VRAM are available in that environment?
6. Which IdP/OIDC issuer, audience, claims, browser origins and mobile token flow are required?
7. What availability, latency, concurrency, freshness, quality and cost targets define acceptance?
8. Is MCP local stdio sufficient, or is remote transport a real requirement?
9. Who owns Qdrant backup/restore, vLLM operations, n8n credentials/workflows, audit and incident response?
10. Which historical task/training data can be migrated automatically, and which needs human review because of the 1/2 swap?
11. Which PDF/DOCX/PPTX/HTML sources and layout/OCR cases are approved for Docling and Unstructured, and what extraction confidence requires human review?
12. Who owns user-memory consent, retention/TTL, conflict, export and deletion policy, and which events may propose—but never silently create—a memory?
