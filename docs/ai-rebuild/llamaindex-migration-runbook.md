# LlamaIndex cutover and rollback runbook

The repository candidate has completed a **local code cutover**: ordinary reads,
ingest, replay, tombstone, reconcile and reindex use LlamaIndex mechanics behind
Eisenhower ports. The replaced Qdrant/chunking engine is no longer present. A
disposable Qdrant 1.18.2 alias cutover and rollback was exercised locally; no
persistent environment, Mikrus host or production alias was changed.

## Fixed boundary and configuration

MongoDB is canonical. Qdrant is a rebuildable projection. Tenant/project/ACL,
`source_sequence`, checksum/version, tombstone, canonical revalidation,
citations, fallback, auth and audit remain Eisenhower policy. LlamaIndex types
must not cross HTTP, MCP, job, audit or application DTO boundaries.

The strong private knowledge host receives:

```text
LLAMAINDEX_CANDIDATE_COLLECTION=eisenhower-knowledge-llama-v1-candidate
LLAMAINDEX_PIPELINE_VERSION=llama-sentence-256-32-v1
LLAMAINDEX_CHUNK_SIZE=256
LLAMAINDEX_CHUNK_OVERLAP=32
QDRANT_COLLECTION_ALIAS=eisenhower-knowledge-active
```

The candidate physical name must differ from the alias and end in `-candidate`.
The running reader/writer fails closed unless the alias targets that exact
candidate. There is no legacy/candidate mode flag and no dual RAG runtime.

The Mikrus `api-boundary` contains only FastAPI/Pydantic/Uvicorn/HTTPX. It sends
the original Bearer token to one allowlisted private URL, strips cookies,
rejects redirects and unknown routes, and does not contain model, OCR,
LlamaIndex or storage dependencies.

## Backfill before cutover

Run only on the stronger host with private MongoDB/Qdrant endpoints and an
exact-pinned embedding model/revision:

```bash
python -m app.rag.llamaindex_backfill_runtime --tenant TENANT --project PROJECT
```

Exit 0 means every selected canonical document was projected or tombstoned;
exit 2 means at least one projection failed. Reruns are document-idempotent,
stale lower sequences are ignored, equal-sequence conflicting payloads fail,
and stale tombstones cannot delete newer nodes. Backfill refuses to run when
the candidate is already the active alias target.

Before switching, require zero pending/drift, record Mongo/corpus digest,
pipeline/embedding versions, physical collection names, evaluation checksum,
Qdrant client/server versions and a restore-tested snapshot. The checked-in
local stack still pins Qdrant 1.12.0; do not reuse its persisted volume with the
qualified 1.18.2 server without the supported sequential-minor upgrade and
restore rehearsal.

## Guarded cutover

The operator defaults to dry-run. It validates the private endpoint, expected
active source and existing target without changing the alias:

```bash
python -m app.rag.llamaindex_cutover_runtime cutover \
  --legacy-collection LEGACY_PHYSICAL \
  --candidate-collection eisenhower-knowledge-llama-v1-candidate \
  --vector-size VECTOR_SIZE
```

Only a separately authorized maintenance operation may append `--apply`. Every
applied transition also requires `--audit-database`, a `0600 --audit-key-file`,
the exact `--release-sha`, and should carry bounded `--actor-id`/`--request-id`.
The operator records durable attempt/result events and compensates the alias
switch if the success audit cannot be appended. Drain/pause writers around the
switch, store the JSON receipt, then start the new artifact. Readiness fails
closed unless the alias targets the candidate. Resume writers only after
authenticated search, ingest/replay and tenant/ACL smokes pass.

## Rollback

Retain both the previous immutable application artifact and legacy physical
collection. While writers are drained, validate then atomically switch back:

```bash
python -m app.rag.llamaindex_cutover_runtime rollback \
  --legacy-collection LEGACY_PHYSICAL \
  --candidate-collection eisenhower-knowledge-llama-v1-candidate \
  --vector-size VECTOR_SIZE

# Repeat with --apply plus the required durable-audit arguments only after the
# dry-run receipt is correct.
```

Restart the retained legacy artifact after the alias rollback. The current
artifact deliberately cannot read the removed legacy payload format. If any
post-cutover canonical writes were accepted, rebuild the legacy projection from
Mongo before reopening traffic; never copy candidate payloads into it. Keep the
candidate for diagnosis and reconcile it from Mongo before any later retry.

## Local evidence and remaining gates

The selected 256/32 local container report covers 36 unapproved train/dev
cases: hybrid Recall@k 0.9107, MRR 0.6577, citation correctness/recall 1.0,
no-answer accuracy 1.0, freshness 1.0, stale/forbidden/isolation rates 0 and p95
54.00 ms. This improves the historical local incumbent assessment but does not
meet the proposed, unapproved MRR 0.8 target and is not human acceptance or a
sealed holdout. The report itself remains the source of truth:
`backend-ai/evaluation/retrieval-v1/llamaindex-cutover-256-local-v3.json`.

Local unit/integration tests, disposable alias rehearsal, image builds and
Compose rendering do not prove deployment, real-host capacity, production data
parity or public production. Measure cold/warm peak RSS and concurrency on the
actual strong host before setting limits. Do not promote an alias, deploy or
delete the retained rollback artifact/collection without separate authority.
