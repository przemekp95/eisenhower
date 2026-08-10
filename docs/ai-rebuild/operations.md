# Observability, rollout, rollback and migration

The repository has local service definitions and request logging, but no evidence in this document set proves deployed AI telemetry, production SLOs or a successful live migration.

## Signals and correlation

Generate or accept a safe `X-Request-ID`/trace ID at the gateway and propagate it through FastAPI, Qdrant, vLLM, job dispatch and n8n. Never use a user-provided value without validation. Async commands additionally carry `event_id`, `job_id`, `idempotency_key` hash and source version.

### Metrics

| Layer | Minimum metrics |
| --- | --- |
| Public API | request count/status/latency by route and mode; auth/rate-limit denial; in-flight requests |
| Retrieval | latency, hits, no-hit ratio, top-score distribution, filtered candidate count, collection/embedding version; no tenant labels with unbounded cardinality |
| Generation | latency, timeout/error/fallback/circuit state, prompt/completion tokens, queue time, structured-output/citation rejection |
| Classifier fallback | invocation rate, latency, confidence distribution, model version |
| Ingestion/jobs | accepted/duplicate/conflict, queue age, attempt count, success/failure/dead-letter, documents/chunks/tombstones, checksum/schema rejection |
| Qdrant | readiness, query/upsert latency/error, vector count, disk/WAL/snapshot health, collection alias/version |
| vLLM/GPU | readiness/model, scheduler queue, KV cache, throughput, OOM, GPU memory/utilization/temperature |
| n8n | execution status/latency, retry/error-workflow, worker/webhook health when queue mode is enabled |
| MCP | tool count/latency/error, upstream response class, authorization denial; never tool arguments/content |

### Logs and traces

Use structured JSON with timestamp, level, service, environment, route/tool/job type, outcome, duration, trace/request/job ID, tenant pseudonym/hash and model/index versions. Do not log bearer tokens, signatures, raw tasks, source text, prompts, citations/excerpts, PII, embeddings or full provider errors by default. Sampling must preserve errors and slow requests without sampling sensitive bodies.

Trace spans should reveal timing and decisions (`auth`, `retrieve`, `generate`, `validate`, `fallback`) but use counts/versions rather than corpus text. Audit events use a separate append-only retention and access policy.

## Suggested SLOs and budgets

Final numbers require product traffic and hardware evidence. Establish separate SLOs for availability and latency of fallback versus generated mode. A safe initial policy is that RAG failure must not reduce fallback availability, and generation has a bounded share of the end-to-end deadline. Define percentile latency, error budget, no-answer/fallback budget, freshness lag and dead-letter age after baseline measurements; do not invent calendar or millisecond guarantees in advance.

## Feature flags

Flags are server-side and tenant-aware:

- `RAG_ENABLED`: legacy compatibility switch; when the two explicit phase flags are absent, it
  sets both retrieval and generation to the same value. New environments should leave it `false`
  and use the explicit flags below.
- `RAG_RETRIEVAL_ENABLED`: constructs the private Qdrant retriever. With response disabled, the
  analyze endpoint records only aggregate hit/no-hit/error shadow metrics and returns the existing
  classifier fallback without retrieval metadata or citations.
- `RAG_GENERATION_ENABLED`: constructs vLLM only after retrieval gates; it is invalid without
  retrieval and remains fail-closed when model, prompt or credential selection is incomplete.
- `RAG_RESPONSE_ENABLED`: allows generated output only when retrieval and generation are active;
  otherwise the user-visible response remains the classifier fallback.
- corpus/index version allowlist and per-tenant rollout cohort.
- `mcp_remote_enabled`: false initially; does not affect local stdio.

Log flag versions and decisions, not sensitive inputs. Default every new environment/tenant to fallback.

Recommended progression is `retrieval=false/generation=false/response=false`, then retrieval-only
shadow, then retrieval plus generation with response still false, and finally an allowlisted
response cohort. Do not enable the next flag merely because the prior mode starts successfully;
its quality, isolation, latency and rollback gate must pass first.

## Zero-downtime rollout

1. **Baseline:** deploy no behavior change; measure classifier latency/error and semantic mapping. Back up canonical data.
2. **Dark index:** ingest a reviewed corpus into a versioned Qdrant collection; no production query uses it.
3. **Shadow retrieval:** run retrieval asynchronously or off the response path for a small cohort; compare goldens and resource cost without exposing results.
4. **Shadow generation:** invoke vLLM within a strict budget for sampled traffic; discard output after validation and compare against goldens/human review.
5. **Internal/canary response:** return grounded results to internal users or one allowlisted tenant. Keep deterministic fallback available.
6. **Progressive expansion:** increase cohorts only while security, quality, latency, cost and fallback thresholds stay green.
7. **General availability:** only after the production-readiness gate and rollback rehearsal.

Schema changes are backward-compatible first: readers tolerate new optional fields, writers dual-write only when necessary, and destructive removal occurs after all clients have migrated. Qdrant index cutover uses aliases; API rollout keeps both fallback and new response schema compatible.

## Rollback

Immediate safe rollback is `rag_response_enabled=false` or master `rag_enabled=false`; FastAPI returns the existing classifier path. For index regression, atomically repoint the Qdrant alias to the retained prior collection. For ingestion regression, pause connector/workflow triggers, preserve the durable queue/dead-letter evidence and reconcile rather than deleting history. For application regression, deploy the prior application artifact while retaining forward-compatible data.

Rollback triggers include tenant-isolation violation, invalid citation leakage, semantic quadrant regression, sustained timeout/error/OOM, audit loss, runaway cost, corpus corruption, retrieval/generation quality below threshold or operational inability to restore. A security isolation incident overrides availability concerns.

## Health endpoints

Liveness answers whether a process loop is alive and must not depend on every downstream. Readiness checks configuration and dependencies needed for the enabled mode. Expose dependency state and version without secrets. If RAG is optional, Qdrant/vLLM failure can keep the API ready in degraded/fallback mode while emitting a high-signal alert; document that semantics at the load balancer.

## Runbooks and production gate

Required runbooks: token/JWKS failure and rotation, Qdrant snapshot/restore and alias rollback, vLLM OOM/circuit open/model rollback, n8n/job dead letter replay, corpus privacy deletion, cross-tenant incident, prompt/citation incident and full fallback activation. No-go until each has an owner, alert, dashboard, access boundary and staged rehearsal.
