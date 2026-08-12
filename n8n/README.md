# n8n asynchronous integration workflows

These inactive importable workflows keep n8n out of every synchronous analysis request. n8n is an orchestration boundary for source polling/webhooks, normalization handoff, reindexing, tombstones, evaluation launches, retry, and alerting. FastAPI remains the owner of domain validation, ACL enforcement, deterministic chunk production, checksums, vector writes, and online retrieval/generation.

Calendar automation follows the same boundary: Node owns task and calendar rules, bindings, conflicts, sync tokens, idempotency and the transactional outbox. n8n owns the Google OAuth credential and performs only the bounded provider calls described by claimed commands. A Google push notification is a signal to pull changes; it is never trusted as event data.

## Workflows

- `workflows/async-rag-ingestion.json` accepts only `upsert`, `tombstone`, `reindex_project`, and `start_rag_evaluation` events. It authenticates the webhook with n8n Header Auth, asks the internal API to verify the HMAC signature and replay window, then dispatches one named asynchronous job with bounded retry.
- `workflows/rag-ingestion-error.json` emits a sanitized alert. It deliberately omits raw input, document content, secrets, and full error objects.
- `contracts/ingestion-event.schema.json` fixes the versioned envelope, ACL metadata, checksums, and embedding/chunking versions. It prevents a source connector from silently changing the indexing contract.
- `workflows/calendar-outbound.json` claims one canonical `event_create`, `event_update` or `event_delete` dispatch from the Node outbox, performs the corresponding Google Calendar call with bounded retry and acknowledges `eventId`, delivery state, connection, provider event ID and ETag back to Node.
- `workflows/calendar-inbound.json` acknowledges the webhook immediately, asks Node to validate and atomically claim the watch signal, then pulls changes using the returned `syncToken`/`pageToken`. It translates only bound timed events into camelCase `event_changed`, `event_deleted` and `sync_checkpoint` commands. `410 Gone` requests a controlled full resync instead of guessing state.
- `workflows/calendar-reconciliation.json` activates the configured connection, claims reconciliation jobs, performs the repair pull and renews the Google watch channel. It intentionally excludes recurrence, all-day events, attendees, Meet and invitation delivery.

There is no generic workflow executor and no n8n MCP server in this scaffold. If n8n MCP is added later, allowlist only individually reviewed workflows such as `sync_calendar`, `reindex_project`, or `start_rag_evaluation`; never expose arbitrary workflow selection, arbitrary URLs, code, commands, or credential access.

## Google Calendar activation

The three Calendar workflows are deliberately imported inactive. Before activation:

1. Create a dedicated Google OAuth credential in the private n8n instance with the minimum Calendar event scope and replace `REPLACE_GOOGLE_CALENDAR_CREDENTIAL_ID` during the controlled import. No client secret or refresh token belongs in Git or workflow JSON.
2. Set `EISENHOWER_NODE_INTERNAL_API_URL`, `CALENDAR_INTERNAL_HMAC_KEY`, `CALENDAR_TENANT_ID`, `CALENDAR_OWNER_ID`, `GOOGLE_CALENDAR_ID` and `GOOGLE_CALENDAR_WEBHOOK_URL`. The HMAC key must be the same dedicated value configured in Node and contain at least 32 bytes. The private Node base URL must not have a trailing slash because the exact request path is signed; the Google webhook URL must be HTTPS and expose only the inbound path through the gateway.
3. Calendar signing uses the Code node's Node.js `crypto` module. Self-hosted n8n must explicitly set `NODE_FUNCTION_ALLOW_BUILTIN=crypto`; do not allow additional built-ins or external modules for these workflows.
4. Connect one explicit calendar in the application. Eisenhower remains authoritative for task lifecycle/quadrant/schedule. Google edits may update the bound title/time only; concurrent edits create a conflict, Google deletion only unbinds the event, and ordinary Google events do not become tasks automatically.
5. Import and inspect all workflows, attach the credential, run a test calendar rehearsal, then activate outbound, inbound and reconciliation together. Record the n8n workflow IDs and credential owner in the private operations inventory.

The checked-in JSON proves source and contract shape only. Until a user grants Google OAuth consent and the workflows are imported and activated, live Calendar synchronization is not deployed.

### Calendar internal HTTP signing

Every Calendar request to Node is signed independently. A signing Code node first creates the final
camelCase body and serializes it exactly once with `JSON.stringify`. The following HTTP Request node sends
that exact string as raw `application/json`; it must never use n8n's JSON-body mode, which could
reserialize the object after signing.

The lower-case hexadecimal signature is HMAC-SHA256 over:

```text
v1 + "\n" + timestamp + "\n" + POST + "\n" + exact_path + "\n" + exact_raw_json
```

Headers are `X-Eisenhower-Timestamp` (Unix seconds) and `X-Eisenhower-Signature`. The exact signed paths
are connection activation, outbox claim/acknowledgement, notification validation, sync apply/reset,
reconciliation claim and watch renewal under `/internal/calendar`. Node enforces the five-minute window
and constant-time digest comparison. There is no bearer-token fallback for these Calendar endpoints.

The outbound claim contract is `eventId`, `type`, tenant/owner/aggregate fields, `payload`, and a
`provider` object containing `connectionId`, `calendarId` and, for update/delete, `providerEventId` and
`providerEtag`. Node must not lease an event that lacks the provider data needed to execute it. Notification
validation returns the authoritative scope, connection/calendar IDs, stored page/sync tokens and `signalId`;
the workflow does not infer them from untrusted Google headers. Reconciliation claim returns `jobs` with
the same authoritative camelCase scope and checkpoint data.

## Security and idempotency contract

Before activating the workflow:

1. Replace import placeholders and create a dedicated Header Auth credential. Keep n8n private; expose only the single ingress path through the application gateway.
2. Configure `EISENHOWER_INTERNAL_API_URL` to a private HTTPS/mTLS endpoint and provide a narrowly scoped `EISENHOWER_INTERNAL_API_TOKEN` through n8n credentials/secrets, not workflow JSON.
3. The source must send `X-Eisenhower-Signature-Version: v1` and calculate lower-case hex HMAC-SHA256 over `v1 + "\\n" + timestamp + "\\n" + "POST" + "\\n" + "/webhook/eisenhower-rag-ingestion" + "\\n" + exact_raw_body`. The timestamp is Unix seconds in `X-Eisenhower-Timestamp`; the digest is `X-Eisenhower-Signature`. Method, production ingress path, version and every body byte are therefore bound by the signature.
4. The Webhook node has **Raw Body** enabled and exposes those bytes as binary field `data`; the verification HTTP node forwards that binary field without JSON parsing/reserialization. FastAPI accepts only `application/json`, enforces an 8 MiB application limit, rejects invalid UTF-8, duplicate keys, non-finite numbers, unknown fields and schema-invalid envelopes, then uses constant-time comparison, a five-minute signature window and an atomic 24-hour `event_id` reservation. Set self-hosted `N8N_PAYLOAD_SIZE_MAX=8` and the gateway body limit to the same or a smaller value; the app limit remains the final fail-closed check. A signature alone does not stop replay.
5. Validate the body before accepting it. Recompute `content_checksum`; never trust a connector-supplied checksum as proof of content integrity.
6. Every internal job endpoint must atomically claim `Idempotency-Key`, return the same job/result for duplicates, and return `202` only after durable enqueue. Retries cover network/5xx failures; validation, authentication, tenant mismatch, and permanent 4xx failures go directly to the error workflow or a dead-letter review queue.
7. Store only minimum execution metadata in n8n. Successful execution data is disabled in the scaffold. Apply retention to failed executions because they can still contain PII.

The internal API must derive tenant/user authorization from the verified credential and compare it with the envelope; never use the envelope tenant as authorization. Source URIs must be allowlisted and fetched by dedicated connectors to avoid SSRF. Tombstones are versioned events, not immediate destructive deletion: the ingestion worker records the tombstone, removes the document from the next index version, and switches the Qdrant collection alias only after validation.

## Deterministic ingestion and reindexing

The source connector emits schema v2 envelopes with normalized documents plus an opaque `source_version`, a per-document monotonic integer `source_sequence`, `content_checksum`, `embedding_version`, and `chunking_version`. The ingestion worker ignores equal or lower sequences, deterministically normalizes line endings/Unicode, chunks by the named chunking version, and derives stable chunk IDs from tenant, project, document, source version, and chunk ordinal. Reprocessing an identical event therefore produces no duplicate vectors, and a delayed older event cannot replace a newer document or tombstone.

Reindex into a new versioned Qdrant collection, validate document/chunk counts and retrieval goldens, then atomically move the alias. Retain the prior collection through the rollback window. An evaluation launch identifies an immutable `dataset_version`; it cannot execute arbitrary code or accept arbitrary remote sources.

## Retry, failure, and queue mode

The HTTP dispatch nodes use five attempts with a two-second delay; the job API provides durable retries with exponential backoff and jitter. Cap attempts and send exhausted jobs to a reviewable dead-letter state. Alert payloads contain workflow/execution identifiers only, so operators retrieve details in the private n8n UI and audit trail.

Start in regular mode. n8n queue mode becomes justified only after measurements show sustained concurrent workflows, long-running connectors, or availability requirements that one process cannot meet. Queue mode adds Redis, workers, shared encryption keys, worker health/metrics, and operational ownership; it does not replace the application's durable job/idempotency store. Keep webhook processors and workers private and do not add Redis preemptively.

Official references:

- [n8n Webhook node and authentication](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)
- [n8n HTTP Request raw and binary bodies](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)
- [n8n error workflows](https://docs.n8n.io/flow-logic/error-handling/)
- [n8n queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/)
- [n8n execution-data configuration](https://docs.n8n.io/hosting/configuration/configuration-examples/execution-data/)

Focused contract tests:

```bash
python3 -m unittest discover -s n8n/tests -v
```
