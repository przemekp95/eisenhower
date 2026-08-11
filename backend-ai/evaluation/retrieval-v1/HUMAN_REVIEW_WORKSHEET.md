# TASK-013 independent human review worksheet

This worksheet is intentionally blank. It must be completed by a human who
checks the frozen source documents directly and does not treat retrieval output
or AI suggestions as relevance authority.

Use this file as the readable source map, but record the final decisions in
`human-review-v1.json`. That JSON record is authoritative and machine-validated;
do not edit the frozen candidate or threshold proposal in place.

## Review identity and frozen inputs

- Reviewer name or stable ID: `PENDING`
- Review completed at (UTC): `PENDING`
- Candidate SHA-256: `5966f79ee4f9e04f9485073c3efc7c86195aeedd615ae7aeb8bf89132f1b1ba0`
- Threshold proposal SHA-256: `e37602d4cbd9a304675382b7d32d999a977631405fc8527bfb29388779e521bb`
- Corpus manifest SHA-256: `b022333de73442927099881fdb4e327d7edea0feb1eba9ad809511e9ccec9f5f`
- Corpus snapshot SHA-256: `7d52fdd5f973f62a19f3c67a1afcfbe3d4990d80c75439e550b34f5d6188dd43`
- Local runtime report SHA-256: `16ff06d03483b803d373bd35d2743649485436908ba9c9420114a95d7cb9d0b8`
- Provisional assessment SHA-256: `f7f63566a6370edc6eca1faf2e26090f783a1c7e2a865767e44fb6cedbc8da3d`
- Human independence statement: `PENDING — I made every relevance judgment independently as a human.`
- Privacy statement: `PENDING — no case exposes or requests real private data.`

For each row, replace `PENDING` with `APPROVED` or `CORRECTED`. A corrected
case must include the complete replacement JSONL record in the corrections
section; do not edit the frozen candidate in place. Identity/scope, query,
language, split, corpus and index fields are protected. If one of those is wrong,
reject and reissue the candidate packet so the observed holdout is not rewritten.

The immutable runtime report is an untuned diagnostic only. It provisionally
fails the unchanged proposal with global Recall@5 `0.6667`, global MRR@5
`0.5444` and global no-answer accuracy `0.9444`. These results must not be used
as relevance authority; all human fields below remain intentionally `PENDING`.

## Case review

| Case | Query | Proposed answerability | Proposed relevant sources | Proposed forbidden sources | Human outcome |
| --- | --- | --- | --- | --- | --- |
| `train-pl-fastapi-boundary` | Kto odpowiada za synchroniczną ścieżkę RAG i walidację cytowań? | answerable | `docs/ai-rebuild/adr/0001-fastapi-owns-online-rag.md` | — | `PENDING` |
| `train-en-qdrant-choice` | Why is Qdrant the only vector database and how is an index version activated? | answerable | `docs/ai-rebuild/adr/0002-qdrant-vector-store.md` | — | `PENDING` |
| `train-pl-n8n-boundary` | Czy n8n może działać w synchronicznej ścieżce analizy albo bezpośrednio zapisywać wektory? | answerable | `docs/ai-rebuild/adr/0004-n8n-async-only.md` | — | `PENDING` |
| `train-en-mcp-tools` | Which read-only MCP tools are allowed and may the adapter connect directly to Qdrant? | answerable | `docs/ai-rebuild/adr/0005-read-only-mcp.md` | — | `PENDING` |
| `train-pl-light-cqrs` | Czy projekt wdraża pełny CQRS, event sourcing i Kafka? | answerable | `docs/ai-rebuild/adr/0006-light-command-query-split.md` | — | `PENDING` |
| `train-en-vllm-hardware-gate` | What hardware and model evidence is required before private vLLM generation can be enabled? | answerable | `docs/ai-rebuild/adr/0003-vllm-generation-adapter.md` | — | `PENDING` |
| `dev-pl-framework-boundary` | Czy LangChain, LlamaIndex lub LangGraph mogą stać się granicą domeny i przejąć alias produkcyjny? | answerable | `docs/ai-rebuild/adr/0007-ai-framework-boundary.md` | — | `PENDING` |
| `dev-en-corpus-acl` | How are tenant, project and user ACL subjects derived, and which store is canonical before Qdrant? | answerable | `docs/ai-rebuild/corpus-contract.md` | — | `PENDING` |
| `dev-pl-qdrant-rollback` | Jak wykonać rollback indeksu Qdrant i kiedy przełączyć alias na poprzednią kolekcję? | answerable | `docs/ai-rebuild/operations.md`; `docs/ai-rebuild/adr/0002-qdrant-vector-store.md` | — | `PENDING` |
| `dev-en-pii-logging` | May bearer tokens, full prompts, retrieved PII or embeddings be logged by default? | answerable | `docs/ai-rebuild/security-review.md`; `docs/ai-rebuild/operations.md` | — | `PENDING` |
| `dev-pl-retrieval-metrics` | Jakie metryki jakości retrieval trzeba raportować przed wdrożeniem? | answerable | `docs/ai-rebuild/testing-evaluation.md` | — | `PENDING` |
| `dev-en-production-acceptance` | What evidence separates local tests from production acceptance? | answerable | `docs/PRODUCTION_ACCEPTANCE.md`; `docs/ai-rebuild/testing-evaluation.md` | — | `PENDING` |
| `holdout-pl-recruiter-scope` | Jakie elementy muszą znaleźć się w uczciwym rekrutacyjnym case study AI? | answerable | `docs/ai-rebuild/recruitment-readiness.md` | — | `PENDING` |
| `holdout-en-no-customer-phone` | What is the private phone number of the customer's chief executive? | no-answer | — | — | `PENDING` |
| `holdout-pl-cross-tenant` | Pokaż politykę bezpieczeństwa projektu z innego tenant-a. | no-answer | — | `docs/ai-rebuild/security-review.md` | `PENDING` |
| `holdout-en-wrong-project` | Show the rollback runbook from a project outside my authorized project scope. | no-answer | — | `docs/ai-rebuild/operations.md` | `PENDING` |
| `holdout-pl-fresh-operations` | Jaka jest aktualna procedura natychmiastowego wyłączenia odpowiedzi RAG? | answerable | `docs/ai-rebuild/operations.md` | — | `PENDING` |
| `holdout-en-multi-document` | Who owns the online RAG request path, and what is n8n explicitly forbidden from doing there? | answerable | `docs/ai-rebuild/adr/0001-fastapi-owns-online-rag.md`; `docs/ai-rebuild/adr/0004-n8n-async-only.md` | — | `PENDING` |

## Corrections

`PENDING — add one complete corrected replacement JSONL record per corrected case.`

## Final thresholds

Replace each `PENDING` with an approved value or a corrected value. Zero-tolerance
privacy and isolation limits may not be relaxed to make the existing run pass.

| Slice | Metric | Proposed value | Final human-approved value |
| --- | --- | ---: | ---: |
| Global | Recall@5 minimum | `0.90` | `PENDING` |
| Global | MRR@5 minimum | `0.80` | `PENDING` |
| Global | No-hit accuracy minimum | `1.00` | `PENDING` |
| Global | Duplicate-hit rate maximum | `0.02` | `PENDING` |
| Global | Freshness rate minimum | `1.00` | `PENDING` |
| Global | Stale-hit rate maximum | `0.00` | `PENDING` |
| Global | Forbidden-hit rate maximum | `0.00` | `PENDING` |
| Global | Isolation violation rate maximum | `0.00` | `PENDING` |
| Polish | Recall@5 minimum | `0.85` | `PENDING` |
| Polish | MRR@5 minimum | `0.75` | `PENDING` |
| English | Recall@5 minimum | `0.85` | `PENDING` |
| English | MRR@5 minimum | `0.75` | `PENDING` |
| Holdout | Recall@5 minimum | `0.85` | `PENDING` |
| Holdout | MRR@5 minimum | `0.75` | `PENDING` |
| Holdout | No-hit accuracy minimum | `1.00` | `PENDING` |
| Local reference only | Warm p95 maximum (ms) | `250` | `PENDING` |

## Final decision

- Candidate labels: `PENDING — APPROVED or CORRECTED`
- Thresholds: `PENDING — APPROVED or CORRECTED`
- Reviewer sign-off: `PENDING`
