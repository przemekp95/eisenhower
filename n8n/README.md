# n8n asynchronous integration workflows

These source-controlled workflows keep n8n out of every synchronous analysis request. n8n is an orchestration boundary for source polling/webhooks, normalization handoff, reindexing, tombstones, evaluation launches, retry, and alerting. FastAPI remains the owner of domain validation, ACL enforcement, deterministic chunk production, checksums, vector writes, and online retrieval/generation. Source JSON stays inactive; the deployment reconciler decides which reviewed definitions are published in the private runtime.

Calendar automation follows the same boundary: Node owns task and calendar rules, per-user encrypted OAuth grants, bindings, conflicts, sync tokens, idempotency and the transactional outbox. n8n is tokenless: it owns no Google credential and performs only bounded, HMAC-signed calls to Node's Calendar provider adapter. A Google push notification is a signal to pull changes; it is never trusted as event data.

## Workflows

- `workflows/async-rag-ingestion.json` accepts only `upsert`, `tombstone`, `reindex_project`, and `start_rag_evaluation` events. It authenticates the webhook with n8n Header Auth, asks the internal API to verify the HMAC signature and replay window, then dispatches one named asynchronous job with bounded retry.
- `workflows/rag-ingestion-error.json` emits a sanitized alert. It deliberately omits raw input, document content, secrets, and full error objects.
- `contracts/ingestion-event.schema.json` fixes the versioned envelope, ACL metadata, checksums, and embedding/chunking versions. It prevents a source connector from silently changing the indexing contract.
- `workflows/calendar-outbound.json` claims one canonical outbox event, sends only its `eventId` to `/internal/calendar/provider/outbound`, and acknowledges the provider result. Node resolves the authoritative connection and encrypted per-user grant.
- `workflows/calendar-inbound.json` acknowledges the webhook immediately, asks Node to validate and atomically claim the watch signal, then requests changes through `/internal/calendar/provider/changes` using only the authoritative `connectionId` and optional checkpoint. It translates only bound timed events into camelCase `event_changed`, `event_deleted` and `sync_checkpoint` commands. `410 Gone` requests a controlled full resync instead of guessing state.
- `workflows/calendar-reconciliation.json` claims authoritative connection jobs, requests repair pages through Node and renews the watch through `/internal/calendar/provider/watch`. It intentionally excludes recurrence, all-day events, attendees, Meet and invitation delivery.

There is no generic workflow executor and no n8n MCP server in this scaffold. If n8n MCP is added later, allowlist only individually reviewed workflows such as `sync_calendar`, `reindex_project`, or `start_rag_evaluation`; never expose arbitrary workflow selection, arbitrary URLs, code, commands, or credential access.

## Deterministic runtime reconciliation

`scripts/reconcile-runtime-container.sh` is the only supported import path for the local production topology. It assigns stable repository IDs to the five allowlisted definitions, exports the installed state, detects definition drift, removes exact-name legacy duplicates, imports only changed definitions, publishes the intended set and then exports again to prove convergence. The n8n process is stopped while the CLI and the narrowly scoped SQLite duplicate cleanup run, so there are no concurrent database writers. An unrelated workflow is never deleted.

Calendar inbound, outbound and reconciliation are published together. The two RAG workflows stay unpublished unless `N8N_RAG_WORKFLOWS_ENABLED=true`, `knowledge-service` passes its live check immediately before reconciliation, and `N8N_RAG_HEADER_AUTH_CREDENTIAL_ID` names an existing n8n `httpHeaderAuth` credential. The reconciler substitutes that runtime ID and the stable error-workflow ID without committing credentials to Git. A failed export, import, publish or post-reconcile comparison restores the pre-reconcile SQLite snapshot, restarts the last known n8n runtime, and aborts deployment before the gateways and smoke checks; the disposable rehearsal separately proves graph activation on n8n 2.4.6.

The full local deploy performs reconciliation automatically. An operator can repeat only that guarded step with:

```bash
deploy/local/deploy.sh reconcile-n8n
```

For a disposable compatibility rehearsal against the pinned image, with no Google request and no access to the deployed n8n volume, run:

```bash
n8n/scripts/rehearse-runtime.sh
```

The rehearsal starts from an empty temporary SQLite database, runs reconciliation twice, injects and repairs active drift plus a stale duplicate, verifies that only the three Calendar workflows are published, and starts n8n 2.4.6 long enough to register their trigger graphs. Internal HTTP targets are loopback discard addresses and the public Calendar URL is `example.invalid`.

## Google Calendar activation

The three Calendar source files are deliberately inactive in Git and are published by reconciliation. Before deploying them:

1. Complete the user-facing Google OAuth flow in Node. Node must store the refresh/access grant encrypted and bind it to the authenticated tenant, owner and Calendar connection. No OAuth client secret, access token or refresh token belongs in n8n, Git or workflow JSON.
2. Set only `EISENHOWER_NODE_INTERNAL_API_URL`, `CALENDAR_INTERNAL_HMAC_KEY` and `GOOGLE_CALENDAR_WEBHOOK_URL` for Calendar orchestration. The HMAC key must be the same dedicated value configured in Node and contain at least 32 bytes. The private Node base URL must not have a trailing slash because the exact request path is signed; the Google webhook URL must be HTTPS and expose only the inbound path through the gateway.
3. Calendar signing uses the Code node's Node.js `crypto` module. Self-hosted n8n must explicitly set `NODE_FUNCTION_ALLOW_BUILTIN=crypto`; do not allow additional built-ins or external modules for these workflows.
4. Run the contract and disposable-runtime rehearsals, then let deployment reconcile outbound, inbound and reconciliation together. There is no workflow or Google credential per user to clone or administer in n8n.

The checked-in JSON and disposable rehearsal prove source, import and n8n graph compatibility only. Until users grant Google OAuth consent to Node and the reconciled runtime is deployed, live Calendar synchronization is not deployed.

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
reconciliation claim, provider outbound/changes/watch and watch renewal under `/internal/calendar`. Node enforces the five-minute window
and constant-time digest comparison. There is no bearer-token fallback for these Calendar endpoints.

The outbound claim contract is `eventId`, `type`, tenant/owner/aggregate fields, `payload`, and a
`provider` object containing `connectionId`, `calendarId` and, for update/delete, `providerEventId` and
`providerEtag`. Node must not lease an event that lacks the provider data needed to execute it. Notification
validation returns the authoritative scope, connection/calendar IDs, stored page/sync tokens and `signalId`;
the workflow does not infer them from untrusted Google headers. Reconciliation claim returns `jobs` with
the same authoritative camelCase scope and checkpoint data.

Provider routes deliberately do not accept tenant or owner as authorization input. Outbound receives only
`eventId`; changes receives `connectionId` plus optional `syncToken`/`pageToken`; watch receives
`connectionId` plus the rendered HTTPS webhook address. Node resolves and verifies the stored connection,
scope and encrypted OAuth grant. n8n must never receive the decrypted grant or choose a grant reference.

## Security and idempotency contract

Before activating the workflow:

1. Replace import placeholders and create a dedicated Header Auth credential. Keep n8n private; expose only the single ingress path through the application gateway.
2. Configure `EISENHOWER_INTERNAL_API_URL` for the private Node business API and `EISENHOWER_KNOWLEDGE_INTERNAL_API_URL` for the private knowledge runtime. Provide a narrowly scoped `EISENHOWER_INTERNAL_API_TOKEN` through n8n credentials/secrets, not workflow JSON.
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
node --test n8n/tests/reconcile-runtime.test.mjs
n8n/scripts/rehearse-runtime.sh
```
