# ADR 0004: n8n is asynchronous orchestration only

Status: accepted; FastAPI webhook verification and durable enqueue are integrated locally, while n8n workflows remain unimported and inactive.

## Decision

n8n may poll or receive events from allowlisted sources, normalize source-specific envelopes, request upsert/tombstone/reindex/evaluation jobs, retry transient dispatch failures and send sanitized alerts. It cannot appear in `/v2/ai/analyze`, own ACL/domain decisions, write vectors directly, fetch arbitrary URLs, run arbitrary workflow names, or store the canonical corpus.

FastAPI/application workers validate the schema, derive authorization from credentials, recompute checksums, chunk deterministically, embed and write the index. Every command has a durable idempotency key.

The local FastAPI boundary exposes allowlisted verification and enqueue routes, persists replay IDs and queued commands in SQLite, and rejects mismatched dispatch signatures/idempotency keys. A Compose-profiled worker now claims and executes upsert/tombstone work with leases, retry and dead-letter, but it has not been started here. Source-to-index automation remains no-go until workflows/credentials are activated and a real source connector plus reindex path pass end to end.

Start in regular mode. Queue mode is justified by measured sustained concurrency, long-running connectors or availability requirements. It adds Redis, workers, shared encryption configuration and worker operations; it is not a substitute for application idempotency or a reason to add Redis early. See [n8n queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/) and [Webhook authentication](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/).

## Gate

Go only after webhook signature/raw-body/replay tests, durable enqueue, retry/dead-letter behavior, credential isolation, PII retention and a reindex rollback rehearsal pass.
