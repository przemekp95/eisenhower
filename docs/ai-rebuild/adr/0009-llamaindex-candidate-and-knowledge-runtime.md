# ADR 0009: LlamaIndex cutover and private knowledge runtime

- Status: Accepted for a locally verified code cutover; deployment and public production are not accepted
- Decision date: 2026-08-15
- Scope: RAG mechanics, Qdrant migration, service placement and rollback

## Decision

Eisenhower uses exact-pinned `llama-index-core` and the Qdrant integration only
inside the private knowledge runtime. `Document`, nodes, `SentenceSplitter`,
`IngestionPipeline`, rebuildable ingestion cache and `QdrantVectorStore` are
adapter details. LlamaIndex's umbrella starter and OpenAI integration are not
installed because this topology uses pinned local/private embedding, reranking
and generation providers. A provider integration is added only when a selected
runtime actually needs it.

MongoDB remains canonical. Eisenhower retains monotonic `source_sequence`,
checksum/version, idempotency, tombstone, reconcile/reindex, audit and auth.
Every Qdrant hit remains an untrusted candidate: tenant/project/ACL, deletion,
pending state, content and metadata are revalidated against Mongo before a
citation. LlamaIndex types do not cross HTTP, MCP, jobs, audit or application
contracts and its cache/docstore is never a source of truth.

The code runtime is cut over, not dual-run: ordinary reads and all projection
lifecycle operations use the LlamaIndex projection behind existing ports. The
superseded Qdrant retriever/ingestion adapter, deterministic chunker and shadow
router were removed after candidate-only composition, semantic comparison and
alias rollback tests. Eisenhower's fielded BM25/RRF and private reranker policy
remain application composition over the same LlamaIndex-produced nodes; they
are not a second vector store or second RAG engine. QueryPipeline is excluded,
and Workflows is unnecessary for this bounded ingest/retrieve flow.

The first projection uses an isolated physical `-candidate` collection. The
reader/writer fails closed unless the active alias points to that exact
collection. Backfill reads Mongo without mutating it and is blocked after
cutover. Projection writes reject stale or equal-sequence-conflicting state and
write new nodes before deleting older ones. A guarded operator validates the
expected source and existing target before atomic cutover or rollback; both
physical collections remain. Applied transitions require the durable audit
ledger; an unavailable result audit triggers an immediate compensating alias
switch. Operational rollback also requires the retained legacy application
artifact, because removed payload mechanics are not kept in the current
artifact.

The small Mikrus profile runs only `api-boundary`: FastAPI, Pydantic, Uvicorn
and HTTPX. Embeddings, LlamaIndex/Qdrant, reranking, ingest/OCR and generation
belong to the private strong-host knowledge runtime. The boundary forwards the
original Bearer token to one fixed allowlisted private URL, strips cookies,
refuses redirects/unknown routes, uses bounded timeouts and preserves
credential-free restrictive CORS plus an unsafe-method Origin gate. Identity is
bearer-only, so classic cookie CSRF is not the primary mechanism; the knowledge
service still authenticates and derives tenant/project/ACL from the principal.

Jobs, signed/idempotent webhooks and the shared worker ingress terminate at the
knowledge service and use the same LlamaIndex writer. The package has genuine
ports-and-adapters and a light command/query split, but not independent CQRS
read/write models or event sourcing. The monorepo is layered/hybrid, not full
DDD: useful domain language and rules exist without proof of rigorously governed
bounded contexts/aggregates throughout. Executable BDD exists in the Node task
domain, not this RAG cutover. This migration records specific red-green cycles;
the presence of other tests is not evidence of repository-wide TDD.

No CPU/RAM limit is selected here. The local host has 109.7 GiB available and
cannot size Mikrus or the strong host. Limits require cold/warm peak and
concurrency measurements on the target hardware.

## Evidence and consequences

The selected local 256/32 comparison on 36 unapproved train/dev cases reports
hybrid Recall@k 0.9107, MRR 0.6577, citation correctness/recall and no-answer
accuracy 1.0, freshness 1.0, zero stale/forbidden/isolation hits and p95 54.00
ms. It is a local improvement over the historical incumbent, but misses a
proposed unapproved MRR 0.8 target and is not human or holdout acceptance.

A disposable Qdrant 1.18.2 test exercised candidate read through the active
alias and atomic rollback while retaining both collections. The checked-in
Qdrant 1.12.0 persisted volume remains an operational upgrade gate. Local
tests, audits, Compose rendering and image/runtime measurements prove only the
source and bounded local artifacts. No Mikrus/strong-host deployment, persistent
alias promotion, production data, public endpoint or human acceptance is
claimed.
