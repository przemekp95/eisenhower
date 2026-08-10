# n8n asynchronous ingestion scaffold

These inactive importable workflows keep n8n out of every synchronous analysis request. n8n is an orchestration boundary for source polling/webhooks, normalization handoff, reindexing, tombstones, evaluation launches, retry, and alerting. FastAPI remains the owner of domain validation, ACL enforcement, deterministic chunk production, checksums, vector writes, and online retrieval/generation.

## Workflows

- `workflows/async-rag-ingestion.json` accepts only `upsert`, `tombstone`, `reindex_project`, and `start_rag_evaluation` events. It authenticates the webhook with n8n Header Auth, asks the internal API to verify the HMAC signature and replay window, then dispatches one named asynchronous job with bounded retry.
- `workflows/rag-ingestion-error.json` emits a sanitized alert. It deliberately omits raw input, document content, secrets, and full error objects.
- `contracts/ingestion-event.schema.json` fixes the versioned envelope, ACL metadata, checksums, and embedding/chunking versions. It prevents a source connector from silently changing the indexing contract.

There is no generic workflow executor and no n8n MCP server in this scaffold. If n8n MCP is added later, allowlist only individually reviewed workflows such as `sync_calendar`, `reindex_project`, or `start_rag_evaluation`; never expose arbitrary workflow selection, arbitrary URLs, code, commands, or credential access.

## Security and idempotency contract

Before activating the workflow:

1. Replace import placeholders and create a dedicated Header Auth credential. Keep n8n private; expose only the single ingress path through the application gateway.
2. Configure `EISENHOWER_INTERNAL_API_URL` to a private HTTPS/mTLS endpoint and provide a narrowly scoped `EISENHOWER_INTERNAL_API_TOKEN` through n8n credentials/secrets, not workflow JSON.
3. The verifier endpoint must validate `X-Eisenhower-Timestamp` and `X-Eisenhower-Signature` over the exact raw request bytes, use constant-time HMAC comparison, reject timestamps outside a five-minute window, and atomically reserve `event_id` for longer than the maximum retry period. A signature alone does not stop replay.
4. Validate the body against the JSON Schema before accepting it. Recompute `content_checksum`; never trust a connector-supplied checksum as proof of content integrity.
5. Every internal job endpoint must atomically claim `Idempotency-Key`, return the same job/result for duplicates, and return `202` only after durable enqueue. Retries cover network/5xx failures; validation, authentication, tenant mismatch, and permanent 4xx failures go directly to the error workflow or a dead-letter review queue.
6. Store only minimum execution metadata in n8n. Successful execution data is disabled in the scaffold. Apply retention to failed executions because they can still contain PII.

The internal API must derive tenant/user authorization from the verified credential and compare it with the envelope; never use the envelope tenant as authorization. Source URIs must be allowlisted and fetched by dedicated connectors to avoid SSRF. Tombstones are versioned events, not immediate destructive deletion: the ingestion worker records the tombstone, removes the document from the next index version, and switches the Qdrant collection alias only after validation.

## Deterministic ingestion and reindexing

The source connector emits schema v2 envelopes with normalized documents plus an opaque `source_version`, a per-document monotonic integer `source_sequence`, `content_checksum`, `embedding_version`, and `chunking_version`. The ingestion worker ignores equal or lower sequences, deterministically normalizes line endings/Unicode, chunks by the named chunking version, and derives stable chunk IDs from tenant, project, document, source version, and chunk ordinal. Reprocessing an identical event therefore produces no duplicate vectors, and a delayed older event cannot replace a newer document or tombstone.

Reindex into a new versioned Qdrant collection, validate document/chunk counts and retrieval goldens, then atomically move the alias. Retain the prior collection through the rollback window. An evaluation launch identifies an immutable `dataset_version`; it cannot execute arbitrary code or accept arbitrary remote sources.

## Retry, failure, and queue mode

The HTTP dispatch nodes use five attempts with a two-second delay; the job API provides durable retries with exponential backoff and jitter. Cap attempts and send exhausted jobs to a reviewable dead-letter state. Alert payloads contain workflow/execution identifiers only, so operators retrieve details in the private n8n UI and audit trail.

Start in regular mode. n8n queue mode becomes justified only after measurements show sustained concurrent workflows, long-running connectors, or availability requirements that one process cannot meet. Queue mode adds Redis, workers, shared encryption keys, worker health/metrics, and operational ownership; it does not replace the application's durable job/idempotency store. Keep webhook processors and workers private and do not add Redis preemptively.

Official references:

- [n8n Webhook node and authentication](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)
- [n8n error workflows](https://docs.n8n.io/flow-logic/error-handling/)
- [n8n queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/)
- [n8n execution-data configuration](https://docs.n8n.io/hosting/configuration/configuration-examples/execution-data/)

Focused contract tests:

```bash
python3 -m unittest discover -s n8n/tests -v
```
