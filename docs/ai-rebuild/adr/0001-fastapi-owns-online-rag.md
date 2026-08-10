# ADR 0001: FastAPI owns online RAG

Status: accepted.

## Decision

FastAPI is the application boundary for every synchronous analysis. It authenticates the principal, derives tenant/user/project scope, queries the `Retriever`, optionally invokes the `GenerationProvider`, validates structured output and citations, and falls back to the existing classifier. The request path cannot depend on n8n.

## Consequences

- Domain authorization and citation policy stay testable without workflow state.
- Clients use one public API and cannot reach Qdrant/vLLM directly.
- Provider failures have one timeout/circuit-breaker/fallback policy.
- FastAPI must expose useful health/metrics without leaking corpus or prompt data.
- The legacy endpoints remain compatibility surfaces only and must not advertise fake LangChain/RAG behavior.

## Gate

Go only when tenant-isolation integration tests, citation validation, bounded timeouts, fallback tests and API contract tests pass. A local unit test alone is insufficient.
