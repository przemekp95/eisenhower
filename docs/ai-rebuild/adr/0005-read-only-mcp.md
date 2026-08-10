# ADR 0005: thin read-only Eisenhower MCP adapter

Status: accepted; local implementation requires runtime integration verification.

## Decision

Expose only `matrix_summary`, `tasks_search`, `task_get`, `project_context`, `knowledge_search`, and `priority_explain`. The adapter calls the existing HTTP API and never connects to MongoDB, Qdrant, vLLM or n8n directly.

Start with local `stdio`. Remote Streamable HTTP requires TLS, MCP authorization, strict `Origin` handling, rate limits and a private bind/gateway. Upstream bearer credentials are scoped read-only and never accepted as tool arguments.

Mutations are a later ADR and require explicit user confirmation, narrow scopes, idempotency and an audit trail. If n8n MCP is ever added, allowlist individual reviewed operations such as `sync_calendar`, `reindex_project`, or `start_rag_evaluation`; never expose a generic workflow executor.

References: [build an MCP server](https://modelcontextprotocol.io/docs/develop/build-server), [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/).

## Gate

Go for `stdio` only after contract tests with the real public API. Remote transport remains no-go until auth, Origin, confused-deputy, token audience, rate-limit and audit tests pass.
