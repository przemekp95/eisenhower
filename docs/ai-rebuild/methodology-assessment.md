# DDD, hexagonal architecture, TDD and BDD assessment

This assessment describes the local worktree observed during the AI rebuild. It is not a claim of organization-wide process adoption.

## DDD

The repository is currently layered/hybrid, not a mature DDD implementation. Some domain terms and application boundaries are explicit, but framework models, dictionaries and service concerns still cross layers.

### Proposed bounded contexts

| Context | Responsibility | Owns | Must not own |
| --- | --- | --- | --- |
| Task Matrix | tasks, urgent/important attributes, canonical quadrant | task rules and matrix views | vector indexing, model prompts |
| AI Prioritization | retrieval/generation/fallback policy and explanations | analyze use case, citation policy, quality version | source polling, client UI |
| Knowledge Corpus | normalized documents, ACL/provenance, chunks, index versions | ingestion/reindex/tombstone rules | synchronous task mutation |
| Identity & Access | principals, tenants/projects, scopes, policy decisions | identity/scope derivation | content or quadrant classification |
| Automation | connector schedules, retry/alert orchestration | workflow execution metadata | domain validation or direct vector policy |
| Integration/MCP | read-only external tool facade | tool schemas and HTTP translation | database/model access or arbitrary execution |

### Ubiquitous language

Use: `Task`, `Urgent`, `Important`, `Quadrant`, `Do Now`, `Delegate`, `Schedule`, `Delete`, `SourceDocument`, `Chunk`, `Citation`, `AccessScope`, `RetrievalHit`, `CorpusVersion`, `EmbeddingVersion`, `Tombstone`, `Analyze`, `Fallback`, `NoAnswer`, `IngestionCommand`, `Job`, and `IdempotencyKey`.

Retire or quarantine misleading language: `use_rag` for local similarity, `analyze-langchain` when no LangChain/LLM exists, `rag_classification` for the MLP classifier, and any mapping where quadrant 1 is Schedule or quadrant 2 is Delegate. Compatibility fields may remain deprecated but cannot define the domain language.

### Layering target

- **Domain:** immutable domain values/invariants and policies; no FastAPI, Qdrant, HTTP, n8n or MCP imports.
- **Application:** `AnalyzeTask`, `SearchKnowledge`, `IngestDocuments`, `TombstoneDocument`, `ReindexCorpus`; orchestrates ports and transaction/idempotency rules.
- **Infrastructure:** MiniLM, Qdrant, vLLM HTTP, document/job stores, OIDC, n8n and MCP transports.
- **Delivery:** FastAPI routes, workflow/webhook adapters, MCP tools and client packages.

Local `rag.models`, `ports`, `application`, `ingestion` and `adapters` move in this direction. Generation-provider failures now use explicit application-level error types; incremental ingestion replaces prior document chunks fail-closed and persists a monotonic source sequence that rejects stale upserts and tombstones. Remaining gaps include a canonical `Quadrant` value object shared across boundaries, a complete canonical document store and transaction/reconciliation strategy for a future multi-consumer topology, route-independent authorization policy, and typed results in the older classifier flow.

The FastAPI delivery boundary is now composed in `app/http/factory.py`; focused middleware, error, schema and router modules own HTTP mapping, while `app/main.py` is a 36-line compatibility export surface. This improves delivery/composition separation without claiming that older classifier policy has become strict hexagonal architecture.

## Hexagonal / ports and adapters

The local experimental RAG package defines `Retriever`, `EmbeddingProvider`, `GenerationProvider`, `DocumentStore`, `IngestionPort` and `FallbackClassifier`. Qdrant, vLLM and MiniLM are useful driven adapters in that bounded slice; FastAPI, MCP and the webhook are driving adapters. Direct framework, persistence and service dependencies remain elsewhere, so the supported monorepo is pragmatic layered/hybrid rather than strict hexagonal architecture.

ADR 0006 records a light command/query separation for the inactive experimental ingestion path. The supported runtime has no separate read/write models, event sourcing or production message bus, so this is not full CQRS.

Required contract refinements:

| Port | Input/output responsibility | Error contract |
| --- | --- | --- |
| `Retriever` | query text, access scope, k/threshold -> ordered authorized hits | timeout/unavailable/configuration separated from empty result |
| `EmbeddingProvider` | batch normalized text -> fixed-dimension vectors + immutable version | dimension/model errors explicit; no hidden remote fetch |
| `GenerationProvider` | task + bounded retrieved context -> structured candidate | unavailable and invalid-output are explicit; transport details do not escape the adapter |
| `DocumentStore` | current canonical document/version/tombstone | optimistic version conflict and not-found explicit |
| `IngestionPort` | fail-closed replacement of tenant/document chunks plus explicit tombstone | retries are idempotent; bulk transaction/reconciliation remains a production gate |

Do not let Qdrant payload models or `httpx` exceptions leak into application/domain tests. Dependency construction belongs in composition/bootstrap. Cross-cutting auth/observability should decorate use cases/ports rather than be reimplemented in clients.

## TDD

Tests exist for several new components, but tests alone do not prove a red-green workflow. Unless contemporaneous failing-before evidence is preserved, describe the process as “test-covered implementation” rather than verified TDD. Task-scoped implementation records may claim TDD only where they record the intended failing check and the later green check; the resulting green suite alone cannot independently reconstruct that history. For remaining work, use explicit red-green-refactor slices: quadrant truth table, authorization failure, retrieval ACL, invalid citations, provider timeout, deterministic ingestion, duplicate webhook/job, MCP allowlist and alias rollback.

TDD is most valuable around stable policy boundaries. Provider smoke tests and infrastructure experiments may start with characterization/contract tests, but changes are accepted only when repeatable automated evidence exists.

## BDD

Ordinary unit/integration tests are not BDD. The Node task API has a bounded executable Cucumber/Gherkin slice under `backend-node/features/`, run by `npm run test:bdd`, covering the four quadrants, task movement/deletion, tenant isolation, bearer authentication, trusted/untrusted browser origins and request validation. It is living behavior documentation for that slice only, not evidence of repository-wide BDD. The cross-service AI/RAG scenarios in [testing-evaluation.md](testing-evaluation.md) remain specification examples rather than an executable acceptance suite. Avoid converting every unit test into verbose Given-When-Then syntax.

## Methodology gate

Go when bounded-context ownership and canonical terms are accepted, ports have adapter contract tests, domain/application code does not import infrastructure, red-green evidence is recorded for new policy work, and critical behavior scenarios are executable. Do not claim full DDD, strict hexagonal architecture, CQRS, TDD or repository-wide BDD adoption without this evidence.
