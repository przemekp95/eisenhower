# Prompt engineering, versioning and evaluation

Status: implemented locally through the candidate/offline boundary. No prompt is a
champion and no live vLLM/model/GPU matrix has passed the production gate.

## Canonical runtime path

The only generative path is:

```text
POST /v2/ai/analyze
-> RagAnalysisService
-> Retriever
-> GenerationProvider
-> OpenAICompatibleGenerationProvider
-> ClassificationOutput Pydantic validation
-> citation allowlist validation
-> rag / no_answer / fallback
```

The false `QuadrantRetrievalQA` and unused llama.cpp provider were removed. The
legacy `/analyze-langchain` route remains a hidden deprecated compatibility alias
for the local non-generative analysis response; it is not described as LLM or RAG.
The research-only LangChain vector adapter source remains quarantined from core imports.
Its dependencies are installed only from `requirements-experimental.txt`; neither the
production image nor the standard dev environment can load it accidentally.

## Immutable prompt artifacts

Candidate PL and EN artifacts live under
`backend-ai/prompts/eisenhower-classifier/1.0.0`. Runtime and tests load them through
the same checksum-verifying `PromptRegistry`. A registry key is
`(prompt_id, prompt_version, language)`; duplicate identities and checksum drift
fail closed.

`PromptSpec` pins domain and tie-break rules, output schema, model and tokenizer
revisions, chat-template hash, token budgets and deterministic generation settings.
Its execution fingerprint also includes retrieval and index versions. Changing any
matrix element therefore changes the evaluation identity even if prompt text is
unchanged.

The current artifacts deliberately contain model-selection sentinels. ADR 0003 has
not selected hardware, a model, tokenizer revision or chat template. Enabling RAG
with these artifacts raises a bounded configuration error before Qdrant or vLLM is
used. Replace them only by creating a new checksummed candidate after the hardware
gate; do not edit a champion in place.

## Structured output and untrusted data

The vLLM request uses `response_format.type=json_schema` with the JSON Schema derived
from `ClassificationOutput`, plus explicit `temperature=0`, `top_p=1`, `n=1`, seed
and `max_tokens`. Pydantic independently forbids extra fields and enforces:

- the canonical `urgent`/`important`/quadrant mapping;
- complete axes for `classified` and no fake quadrant for `insufficient_evidence`;
- bounded facts, evidence, explanations and citations;
- unique citations and evidence-to-citation consistency;
- application allowlisting of every citation/evidence chunk against rendered context.

Task and retrieved chunks are JSON-serialized only into the user message, inside
explicit untrusted-data containers. They never enter the system message. The
renderer deduplicates chunks, caps chunks per document and removes complete
lowest-score chunks. It never character-slices task or context.

## Token budgets

The 8,192 profile reserves 700 system, 300 task, a shared 4,800 RAG-plus-memory
pool, 400 serialization, 512 output and 1,280 safety tokens, for a total maximum of
7,992. The checked-in candidate assigns 4,288 to RAG and 512 to future memory. The
model rejects configurations where RAG plus memory exceeds 4,800 or all reservations
exceed the model context.

Before the HTTP call, `HuggingFaceTokenCounter` applies the pinned tokenizer's real
chat template, verifies its SHA-256 and counts complete rendered messages. An
oversized task is rejected; protected rules, schema reserve and output reserve are
never silently truncated.

## Evaluation and regression policy

`golden-synthetic-v1` covers all quadrants, the 1/2 boundary, deadline/impact
tie-breaks, insufficient evidence, task and document injection, misleading
similarity, conflicting/irrelevant/duplicate context, citation-ID injection,
deleted/cross-tenant data, PL/EN, Unicode/emoji, length boundaries, invalid schema,
truncated output and provider fallback.

The runner records prompt/model/schema execution metadata and reports accuracy,
macro-F1, per-quadrant precision/recall/F1, retrieval recall/MRR, groundedness,
citation precision/recall, no-answer precision/recall/F1, schema-valid rate,
fallback rate, injection attack success rate, Brier/ECE, latency and token use,
including PL/EN slices.

`evaluation/policy-v1.json` is immutable release policy input. The gate requires
100% semantic/schema validity, zero successful critical injection, citation
correctness at least 0.98, groundedness at least 0.95, no-answer F1 at least 0.90,
bounded aggregate/language/quadrant regressions and no worse calibration. Latency
and prompt-token growth are capped at 10% unless a separately reviewed policy
version changes that decision.

## Promotion and remaining gates

Promotion remains:

```text
draft -> offline candidate -> shadow -> 5% canary -> 25% -> champion
```

Only candidate/offline mechanics are implemented. Shadow traffic, stable tenant
assignment, automated canary stop conditions, atomic champion pointer switching,
retention of the previous model adapter and rollback drills remain required work.
Request bodies cannot select prompt templates or versions.

The generic CPU suite proves local contracts with `httpx.MockTransport`. The opt-in
`vllm_contract` tests make real OpenAI-compatible requests, repeat the fixed matrix
and test a known unsupported schema feature. They require an explicitly selected
model, prompt directory and controlled vLLM endpoint. Until that suite passes on the
target hardware, structured-output compatibility, determinism, latency, throughput,
VRAM/OOM behavior and production readiness are unverified.

## TDD evidence for this change

The implementation record for this change reports explicit red-green loops: missing
generation modules, old adapter constructor/output schema, old orchestration contract,
missing config and a missing regression gate each failed first, then focused suites
passed. The repository preserves the resulting green regression suite but not the
failing-before output, so this is task-scoped process evidence, not proof of historical
repository-wide TDD.
