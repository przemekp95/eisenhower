# Architecture decision records

These ADRs describe the intended architecture. A decision marked accepted does not mean its production gate has passed.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-fastapi-owns-online-rag.md) | FastAPI owns the synchronous RAG path | Accepted; local implementation present, live topology unverified |
| [0002](0002-qdrant-vector-store.md) | Use Qdrant, not a parallel PGVector stack | Accepted; live operation unverified |
| [0003](0003-vllm-generation-adapter.md) | vLLM behind an OpenAI-compatible private adapter | Accepted with hardware gate |
| [0004](0004-n8n-async-only.md) | n8n is asynchronous orchestration only | Accepted; FastAPI ingress/enqueue wired, workflows inactive |
| [0005](0005-read-only-mcp.md) | Start with a thin read-only MCP adapter | Accepted; local adapter present |
| [0006](0006-light-command-query-split.md) | Separate commands and queries lightly, without full CQRS | Accepted; durable enqueue and local consumer implemented, runtime inactive |
| [0007](0007-ai-framework-boundary.md) | Keep application policy framework-neutral; the small custom mechanics decision is superseded | Superseded in part by ADR 0009 |
| [0008](0008-grounded-information-delta.md) | Keep grounded information-delta handling inside Eisenhower policy | Accepted with rollout gates |
| [0009](0009-llamaindex-candidate-and-knowledge-runtime.md) | Adopt LlamaIndex mechanics in an isolated candidate and move heavy RAG off Mikrus | Local candidate accepted; rollout and alias promotion unapproved |
