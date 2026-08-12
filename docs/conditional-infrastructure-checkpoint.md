# Conditional infrastructure checkpoint

Decision date: 2026-08-12

The owner has approved human decision gates through 2026-08-15, but these additions still require
measured technical triggers. Approval is not a substitute for evidence that they solve a real
bottleneck.

| Capability | Current decision | Trigger required before implementation |
| --- | --- | --- |
| Result or prefix cache | Defer | Privacy-safe telemetry shows repeated expensive queries with a material latency or cost contribution, plus scoped-key and invalidation tests. The unused Redis service is behind an explicit Compose profile. |
| Remote MCP | Defer | A concrete external ChatGPT/Codex integration is selected, with OAuth resource-server validation, TLS/gateway, Host/Origin checks, limits and the durable MCP audit path. Local stdio MCP remains supported. |
| Horizontal replicas | Defer | Same-SHA production measurements show the single-instance throughput or availability target is missed. Process-local metrics and SQLite ownership must be redesigned first. |
| GraphRAG | Defer | The approved hybrid comparison still misses a representative, separately labelled entity-relation or multi-hop slice by an agreed material margin. |

CDN and managed queues are not candidates in this checkpoint. The current SQLite job worker is
retained; Kafka, RabbitMQ and service-bus infrastructure remain out of scope.

This checkpoint records a deliberate non-addition. It does not claim production telemetry exists;
the public runtime, traffic baseline and same-SHA alert delivery remain separate acceptance work.
