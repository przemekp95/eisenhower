# Test and evaluation strategy

Passing source-level or mock tests is not deployment evidence. Each gate records the artifact SHA, configuration, model/index/dataset versions, environment and command/report. Tests that require Qdrant, vLLM, n8n, an IdP or GPU must run against those real dependencies before production.

## Test pyramid and ownership

| Level | Scope | Examples |
| --- | --- | --- |
| Unit | domain/application policies without network | quadrant truth table; ACL subject construction; deterministic chunk IDs; citation allowlist; fallback reasons; retry classification |
| Integration | one real adapter/dependency | Qdrant filters/index/aliases/tombstones; OIDC/JWKS; SQLite crash behavior; raw webhook signatures; live API routing |
| Contract | provider/client boundary | vLLM OpenAI-compatible schema/error/timeout; Qdrant client version; HTTP API/client package; MCP tools; n8n event schema |
| End-to-end | representative topology | source event to searchable citation; browser/mobile analyze; MCP read; Qdrant/vLLM outage fallback; reindex alias rollback |
| Security | adversarial boundaries | tenant leakage; CSRF/Origin/CORS; SSRF; replay; confused deputy; prompt injection; rate limits; PII/log leakage |
| Evaluation | quality and operational fitness | Recall@k, MRR, groundedness, citation correctness, no-answer, classification accuracy, latency/resource cost |

## Phase 0 semantic regression suite

One parameterized truth table must cover backend, API client, web, mobile and MCP: `(urgent, important) -> quadrant ID/label`. Fixtures and stored examples require a migration/quarantine test proving that quadrant 1 means Delegate and quadrant 2 means Schedule. Legacy response keys are checked only for backward compatibility and cannot be described as RAG.

## Retrieval metrics

For each query `q` with relevant chunk/document set `R_q`:

- `Recall@k = |top_k(q) ∩ R_q| / |R_q|`; report macro average and slices.
- `MRR@k = mean(1 / rank(first relevant result))`, zero when none appears in top k.
- Also report document-level versus chunk-level relevance, duplicate-chunk rate, no-hit rate and score distributions.

Slice by language (Polish/English), tenant, source type, project scope, task length, recency, ambiguous quadrant and access pattern. Never merge results across tenants to improve a metric.

Do not set final thresholds without a representative dataset and baseline. The release ADR records thresholds after measuring current MiniLM similarity, Qdrant retrieval variants and human agreement. Optimize against held-out queries; do not tune and report on the same set.

## Generation and citation metrics

- **Groundedness:** every factual proposition in the explanation is supported by retrieved, accessible text; grade with deterministic checks plus blinded human review. An LLM judge may assist but cannot be the sole gate and must have a calibrated version/prompt.
- **Citation correctness/precision:** cited chunks actually support the associated claim.
- **Citation completeness/recall:** supported factual claims include a citation when required.
- **Citation validity:** every ID was in this request's retrieved set, belongs to the authorized scope and matches returned metadata/version. This must be 100% by deterministic validation.
- **Classification:** quadrant accuracy/F1/confusion matrix, emphasizing the 1/2 boundary; compare generator, fallback and human labels.
- **No-answer/fallback:** precision/recall on answerable versus unanswerable/insufficient-context cases; separately count no hits, provider unavailable, invalid output and invalid citations.
- **Robustness:** prompt injection success rate, format rejection, citation fabrication, multilingual/paraphrase sensitivity and stale/deleted-content leakage.

## Latency and capacity

Measure cold/warm p50/p95/p99 and timeout rates for embedding, Qdrant, vLLM queue/prefill/decode, validation and total API. Test agreed concurrency, burst, long input/context, dependency slowdown, OOM, connection exhaustion and circuit transition. Report fallback latency independently. Capture GPU/VRAM/KV-cache, CPU, RAM, disk and network; a result from an unrepresentative developer machine cannot choose the production model.

## Golden dataset schema

Store an immutable, reviewed manifest in a protected test-data location; avoid production PII. Suggested JSONL record:

```json
{
  "dataset_version": "golden-2026-08-v1",
  "case_id": "pl-project-deadline-001",
  "tenant_id": "synthetic-tenant-a",
  "principal": {"user_id":"u1","project_ids":["p1"],"roles":["member"]},
  "language": "pl",
  "task": "Przygotuj raport przed spotkaniem o 14:00",
  "expected_quadrant": 0,
  "answerability": "answerable",
  "relevant_document_ids": ["p1-deadlines"],
  "relevant_chunk_ids": ["stable-test-chunk-id"],
  "forbidden_document_ids": ["other-tenant-secret"],
  "required_claims": ["A deadline exists before the meeting"],
  "forbidden_claims": ["Unstated customer details"],
  "tags": ["pl","deadline","tenant-isolation"],
  "labelers": ["reviewer-a","reviewer-b"],
  "adjudication": "reviewer-c",
  "source_snapshot_version": "synthetic-corpus-v1"
}
```

Include: four canonical quadrants; hard 1-versus-2 distinctions; insufficient context; conflicting sources; deleted/stale versions; no hits; multilingual cases; OCR noise; long inputs; ACL/project denial; cross-tenant near-duplicates; injection strings; valid/invalid citations; provider timeout/malformed JSON. Maintain train/dev/test separation and a never-tuned final holdout.

## BDD acceptance scenarios

Executable Gherkin or equivalent living scenarios should describe cross-service behavior. Example:

```gherkin
Feature: Grounded tenant-isolated prioritization
  Scenario: A project member receives a cited grounded result
    Given tenant A has an active accessible deadline document
    And the active index contains its current version
    When the member analyzes a matching task
    Then the response mode is "rag"
    And every citation belongs to tenant A and the member's project
    And the quadrant follows the canonical truth table

  Scenario: Generation is unavailable
    Given retrieval returns authorized chunks
    And vLLM exceeds the generation deadline
    When the member analyzes a task
    Then the response mode is "fallback"
    And no generated explanation is represented as grounded

  Scenario: A replayed ingestion event is rejected
    Given a correctly signed event was durably accepted
    When the same event id is delivered again
    Then no duplicate job or vector is created
    And the duplicate outcome is auditable
```

## Test quality and TDD evidence

The presence of tests does not prove TDD. A red-green-refactor claim requires contemporaneous evidence that the new test failed for the intended reason before implementation and passed after the minimal change; preserve CI logs or reviewed commit history where policy allows. Mutation testing on security/domain policy and coverage of failure branches are useful quality signals, not substitutes for behavior review.

## Release evaluation gate

No-go until the canonical semantics, API/provider contracts, real Qdrant isolation, real selected vLLM model/hardware, source-to-citation E2E, prompt/security suite, golden quality thresholds, latency/capacity, fallback and rollback tests pass in a production-like environment. Record known flaky/quarantined tests; a quarantined tenant/security/citation test blocks release.
