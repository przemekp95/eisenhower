# Recruiter-aligned AI delivery plan

Last reviewed: 2026-08-10

This plan turns the reviewed AI/RAG/MAG technology graphics into one coherent, defensible
portfolio story. It is an implementation backlog, not a claim that every capability is already
running. Source code, local tests, a deployed runtime, representative evaluation and a public demo
remain separate evidence levels.

## Outcome we want to demonstrate

The completed case study should show a privacy-aware multilingual AI system rather than a catalog
of unrelated libraries:

```text
reviewed documents
-> Docling primary extraction / Unstructured fallback
-> deterministic normalization, chunking and checksums
-> multilingual MiniLM embeddings
-> tenant/project/ACL-filtered Qdrant retrieval
-> private vLLM structured generation
-> Pydantic validation, citations, no-answer and MiniLM+MLP fallback
-> retrieval/generation evaluation and Prometheus/Grafana evidence
-> read-only MCP and bounded asynchronous n8n ingestion
-> explicit-consent user memory (MAG)
```

Web and mobile remain public clients of the HTTP API. Qdrant, vLLM, n8n and memory storage remain
private infrastructure. No library or platform may be advertised from a dependency, mock, local
scaffold or configuration file alone.

## Market signal snapshot

The snapshot below is directional and time-specific. Counts overlap because one vacancy may carry
multiple categories and tags.

| Signal on czyjesteldorado.pl | Snapshot | Portfolio response |
| --- | ---: | --- |
| [AI/GenAI category](https://czyjesteldorado.pl/praca/kategoria/ai) | 1,856 | Complete an end-to-end evaluated AI use case. |
| [Generative AI](https://czyjesteldorado.pl/praca/tag/generative-ai) | 3,212 | Prove private structured generation rather than a prompt-only demo. |
| [LLM](https://czyjesteldorado.pl/praca/tag/llm) | 515 | Run one pinned open model through vLLM with live contract evidence. |
| [RAG](https://czyjesteldorado.pl/praca/tag/rag) | 174 | Demonstrate corpus governance, retrieval quality, citations and rollback. |
| [Python](https://czyjesteldorado.pl/praca/tag/python) | 3,691 | Keep FastAPI/application code and tests as the primary implementation. |
| [Docker](https://czyjesteldorado.pl/praca/tag/docker) | 1,421 | Keep the reproducible private topology and immutable runtime evidence. |
| [FastAPI](https://czyjesteldorado.pl/praca/tag/fastapi) | 182 | Keep FastAPI as the online application and security boundary. |
| [PyTorch](https://czyjesteldorado.pl/praca/tag/pytorch) | 223 | Preserve the real MiniLM+MLP classifier and evaluation evidence. |
| [LangChain](https://czyjesteldorado.pl/praca/tag/langchain) | 86 | Retain only a bounded adapter/comparison; do not make it the domain boundary. |
| [Qdrant](https://czyjesteldorado.pl/praca/tag/qdrant) | 8 | Use it deeply and defensibly rather than adding multiple vector databases. |
| [n8n](https://czyjesteldorado.pl/praca/tag/n8n) | 27 | Use it only for reviewed asynchronous orchestration. |

Market counts do not override product fit. Kubernetes, cloud or SQL work belongs here only after a
real deployment or use case exists; adding manifests, logos or an unrelated SQL agent is not an
acceptance criterion.

## Required delivery scope

### Retrieval and grounded generation

- Approve a small public or explicitly consented corpus with ownership, provenance, ACL, retention,
  deletion and PII rules.
- Implement one allowlisted source connector and a canonical document lifecycle before vector
  writes.
- Exercise real Qdrant tenant/project/ACL isolation, versioned collections, snapshots, restore and
  alias rollback.
- Freeze a human-reviewed PL/EN retrieval set and measure Recall@k, MRR, duplicates, freshness,
  forbidden hits and no-hit behavior.
- Run retrieval-only shadow mode before enabling generated responses.
- Select one licensed open model for measured target hardware and serve it through private vLLM.
- Enforce immutable PromptSpec artifacts, tokenizer/chat-template hashes, JSON Schema, Pydantic
  invariants, valid citations, bounded token budgets, no-answer and deterministic classifier
  fallback.

### Document extraction with Docling and Unstructured

Document extraction is committed scope, not a future option:

- Docling is the primary reviewed parser for supported PDF/DOCX/PPTX/HTML inputs.
- Unstructured is a bounded fallback for formats or layouts in the approved corpus where Docling
  cannot satisfy the extraction contract.
- Both adapters sit behind a project-owned `DocumentExtractor` port. Framework-specific document
  types never enter the application/domain contract.
- Inputs are allowlisted by source, media type, extension and size. Archives, encrypted documents,
  embedded executables, external URL fetching and unsupported formats fail closed.
- Normalization preserves headings, lists, tables, page/source spans and provenance. OCR output is
  marked as OCR-derived and cannot enter the corpus without the approved review policy.
- Golden fixtures cover Polish/English text, tables, malformed files, prompt injection, secrets/PII
  redaction decisions, deterministic reruns and deletion/reindex behavior.
- A benchmark records extraction quality, rejected inputs, latency, memory use and the exact
  Docling/Unstructured versions before enabling either adapter for real documents.

### Consent-governed MAG

Memory-Augmented Generation is committed scope after the grounded RAG baseline is stable. It is not
an autonomous-memory feature:

- MongoDB is the source of truth for user memories; Qdrant may contain only a rebuildable searchable
  projection in a collection separate from the knowledge corpus.
- A memory records tenant/user scope, type, source event, provenance, explicit consent, confidence,
  salience, created/updated/expiry timestamps, retention class, checksum, supersession and status.
- Mutations support create/confirm, supersede, revoke consent, delete and export. Consequential
  writes require explicit user confirmation and idempotency.
- Retrieval applies tenant, user, ACL, consent, active-status and expiry filters before ranking by
  semantic similarity, recency, salience and confidence.
- Every Qdrant memory hit is revalidated against MongoDB before prompt use. Knowledge and memory
  have separate budgets, citations/provenance and deletion/reindex paths.
- Conflicts are surfaced to the user; neither an LLM nor n8n silently resolves them. n8n may run
  approved expiry, consolidation, export or reindex commands but cannot decide consent.
- Evaluation covers measurable task benefit, false-memory rate, stale/conflict rate, poisoning,
  isolation, deletion/export completeness, latency and token cost.

### Integrations, operations and recruiter-facing evidence

- Keep the six read-only MCP tools and prove them against the same scoped public API and citations.
- Activate only named n8n workflows with signed webhooks, replay protection, idempotency,
  retry/dead-letter and sanitized error handling.
- Add AI-specific Prometheus/Grafana views for retrieval quality, generation/citation rejection,
  fallback, latency, token buckets, queue health and memory outcomes without logging corpus or PII.
- Publish a technical case study only after the underlying immutable SHA and evidence are available.
  It should include the architecture, threat boundaries, ADRs, live/demo status, evaluation reports,
  failure modes and rollback—not an unsupported technology logo wall.

## Bounded supporting technologies

- LangChain remains an experimental adapter/comparison only. The canonical pipeline stays in
  project-owned ports and application services.
- A reranker is implemented only when held-out evaluation proves ranking, rather than recall, is the
  limiting problem.
- Kubernetes or a public-cloud deployment is added only with a real operated target, health checks,
  observability, cost evidence and rollback.
- LoRA or generative-model fine-tuning requires a separate approved dataset and a measurable gap that
  prompting/retrieval cannot close.

## Explicit non-goals

- No CrewAI, LangGraph, AutoGen, planner/reflection loop or multi-agent system without a separately
  approved user workflow and threat model.
- No SQL agent for the MongoDB-based application and no arbitrary database-query tool.
- No second vector database beside Qdrant merely for technology coverage.
- No parallel Ollama, LM Studio, SGLang and vLLM serving stacks; vLLM is the selected target.
- No generic URL fetcher, shell/filesystem tool, generic n8n executor or blind indexing of email,
  chat, calendar, history, attachments or unreviewed OCR.
- No Mem0, Zep or Letta dependency as a substitute for the explicit MAG domain and consent model.
- No Langfuse/LangSmith/Phoenix/Opik collection by default; extend the existing metrics stack first
  and adopt a specialist tool only for a measured missing capability.

## Delivery order and source of truth

TaskPlanner is the executable source of truth:

1. TASK-010 through TASK-015 complete the governed RAG, real Qdrant evaluation, shadow retrieval and
   private vLLM path.
2. TASK-018 delivers Docling/Unstructured extraction behind the canonical ingestion contract.
3. TASK-019 delivers consent-governed MAG as a separate memory domain and projection.
4. TASK-020 packages the verified system as a recruiter-facing technical case study and demo.

Docling/Unstructured work may begin once TASK-010 approves document sources and formats; its output
must still pass TASK-011's canonical document lifecycle. MAG design/tests may start earlier, but no
real memory write or response augmentation is enabled before the RAG and consent gates pass.
