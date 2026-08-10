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

## Hexagonal / ports and adapters

The local code defines `Retriever`, `EmbeddingProvider`, `GenerationProvider`, `DocumentStore`, `IngestionPort` and `FallbackClassifier`. These are useful driven ports. Qdrant, vLLM and MiniLM are adapters; FastAPI/MCP/webhook are driving adapters.

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

Tests exist for several new components, but tests alone do not prove a red-green workflow. Unless failing-before evidence is preserved, describe the process as “test-covered implementation” rather than verified TDD. For remaining work, use explicit red-green-refactor slices: quadrant truth table, authorization failure, retrieval ACL, invalid citations, provider timeout, deterministic ingestion, duplicate webhook/job, MCP allowlist and alias rollback.

TDD is most valuable around stable policy boundaries. Provider smoke tests and infrastructure experiments may start with characterization/contract tests, but changes are accepted only when repeatable automated evidence exists.

## BDD

Ordinary unit/integration tests are not BDD. The local repository has test files but this assessment does not establish executable Gherkin, shared product scenarios or living behavior documentation. Add a small set of cross-service acceptance scenarios from [testing-evaluation.md](testing-evaluation.md), reviewed by product/security/engineering, and run them in a production-like topology. Avoid converting every unit test into verbose Given-When-Then syntax.

## Methodology gate

Go when bounded-context ownership and canonical terms are accepted, ports have adapter contract tests, domain/application code does not import infrastructure, red-green evidence is recorded for new policy work, and critical behavior scenarios are executable. Do not claim full DDD, TDD or BDD adoption without this evidence.
