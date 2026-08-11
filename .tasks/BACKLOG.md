# Backlog

## TASK-014: Run the retrieval-only shadow pilot
**Priority:** P1 | **Tags:** rag, shadow, production, observability

Deploy retrieval-only to an allowlisted internal cohort with `RAG_GENERATION_ENABLED=false` and `RAG_RESPONSE_ENABLED=false`, then compare aggregate retrieval quality, latency, freshness, errors, and fallback health without exposing retrieved content.

### Plan

- Require the supported P0 release gates and TASK-010 through TASK-013 to pass first.
- Deploy an immutable SHA with a rollback flag and bounded tenant cohort.
- Review telemetry and human samples, rehearse disable/rollback, and record a go/no-go decision.

### Resume gate

Requires explicit deployment authorization, approved production origins/identity, real traffic, monitoring ownership, and privacy-safe sampling.

---

## TASK-015: Select and validate private vLLM generation
**Priority:** P2 | **Tags:** rag, vllm, gpu, citations

After retrieval proves useful, select a licensed model for the actual GPU/runtime and validate private structured generation, grounded citations, no-answer behavior, security, capacity, shadow generation, and response canary gates.

### Plan

- Inventory target GPU/VRAM/runtime and approve model license, residency, tokenizer, chat template, and immutable revisions.
- Run live vLLM contract, adversarial, groundedness, citation, latency, capacity, OOM, and fallback tests.
- Keep responses disabled through shadow generation; enable only an approved cohort after rollback rehearsal.

### Resume gate

Blocked until TASK-014 passes and the hardware/model/privacy owners make the recorded decisions. Reranking, hybrid search, knowledge graph, and agentic RAG remain governed by TASK-007 and require separate ADR triggers.

---

## TASK-006: Revisit the React Native 0.84 migration when Expo supports it
**Priority:** P3 | **Tags:** mobile, dependencies, deferred

Keep the supported Expo 55 dependency baseline. Reassess React Native 0.84 or newer only after a stable Expo release supports it and the full mobile and native Android gates can run.

### Plan

- Check the stable Expo compatibility matrix when a newer supported line exists.
- Upgrade as one deliberate platform migration and run the complete mobile/native Android verification.

---
