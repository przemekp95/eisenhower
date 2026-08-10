# Backlog

## TASK-010: Approve the first RAG corpus and privacy manifest
**Priority:** P1 | **Tags:** rag, corpus, privacy, human-gate

Choose the first canonical knowledge sources and record ownership, tenant/project ACL derivation, provenance, retention, deletion, PII handling, source connector, and explicit exclusions before any real user content is indexed.

### Plan

- Select the smallest product use case where project context measurably improves prioritization.
- Complete the corpus manifest and privacy/retention decisions with the responsible human owners.
- Approve a synthetic-to-real-data transition and keep unapproved sources fail-closed.

### Resume gate

Requires explicit user/data-owner decisions; Codex must not infer consent to index tasks, notes, calendars, chats, email, OCR, or history.

---

## TASK-011: Complete the canonical RAG ingestion contract
**Priority:** P1 | **Tags:** rag, ingestion, data-integrity

Implement the approved source connector and canonical document lifecycle with deterministic source-specific normalization, schema/chunking versions, project metadata, reconciliation, reindex, and privacy deletion semantics.

### Plan

- Add red contract tests for normalization, versions, stale updates, deletes, and source boundaries.
- Keep source HTTP/SDK access behind an allowlisted connector port and persist canonical documents before vector writes.
- Implement reconciliation and a real project reindex handler without widening the existing signed job allowlist.

### Resume gate

Blocked on TASK-010. Do not build a generic URL fetcher or guess a canonical source.

---

## TASK-012: Prove Qdrant isolation, reindex, backup, and rollback
**Priority:** P1 | **Tags:** rag, qdrant, integration, recovery

Run production-like Qdrant integration tests for tenant/project/ACL isolation, tombstones, versioned collections, alias cutover, snapshots, restore, and rollback using the approved corpus contract.

### Plan

- Exercise a real Qdrant service rather than only mocks or in-memory client mode.
- Verify cross-tenant/project denial, stale-content removal, snapshot checksums, isolated restore, and alias rollback.
- Record exact Qdrant version, commands, artifact hashes, timings, and retained previous collection.

### Resume gate

Local container evidence is not production recovery evidence; target-environment rehearsal requires the Qdrant runtime and an operational owner.

---

## TASK-013: Approve representative retrieval quality gates
**Priority:** P1 | **Tags:** rag, evaluation, recall, mrr, human-gate

Build a human-reviewed PL/EN retrieval golden set from the approved corpus and establish Recall@k, MRR, no-hit, duplicate, freshness, and isolation thresholds before tuning retrieval.

### Plan

- Freeze train/dev/holdout queries with relevant, forbidden, stale, and deleted document labels.
- Run the existing evaluator against the real Qdrant candidate and report required slices.
- Obtain human approval for thresholds and preserve the immutable dataset/report hashes.

### Resume gate

Synthetic fixtures remain smoke tests; representative relevance labels and final thresholds require human review after TASK-010 through TASK-012.

---

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
