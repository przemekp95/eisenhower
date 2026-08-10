# ADR 0006: light command/query separation, not full CQRS

Status: accepted; durable command intake and the local consumer lifecycle are implemented, but the runtime has not been activated in production.

## Decision

Queries (`analyze`, `knowledge_search`, MCP reads) return synchronously and never enqueue hidden mutations. Commands (`upsert`, `tombstone`, `reindex_project`, `evaluate`) are asynchronous, idempotent and return a job identity after durable enqueue. Webhooks are transport adapters for commands, not a message bus containing domain logic.

Use explicit application services and ports rather than introducing a CQRS framework, event sourcing, Kafka or a general service bus. A small durable single-node queue can serve the initial deployment; move to a managed queue only when concurrency, multi-replica claims, delivery guarantees or operational evidence require it.

The FastAPI implementation validates and durably enqueues four allowlisted command types in SQLite with stable idempotency. The local worker implements leased claim/crash reclaim, completion, bounded exponential retry with jitter and dead-letter. Upsert and tombstone have concrete tenant-scoped handlers; evaluation has a repository runner. A real project reindex remains blocked on the selected source connector and must not be represented as active.

## Consequences

- Read latency and async retry behavior stay independent.
- A job state machine needs `queued`, `running`, `succeeded`, `retry_wait`, `dead_letter` and cancellation policy.
- Events need schema versions, trace/correlation IDs and an outbox or equivalent atomic handoff if commands originate with database writes.
- SQLite is not a multi-replica production queue.

## Gate

Go only when duplicate delivery, crash recovery, poison messages, ordering assumptions and job status/audit tests pass for the chosen runtime topology.
