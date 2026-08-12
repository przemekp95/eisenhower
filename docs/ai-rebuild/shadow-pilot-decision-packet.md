# TASK-014 retrieval-only shadow pilot decision packet

Status: **no-go; deployment not authorized and TASK-013 does not pass**

## Current technical gate

The owner-refrozen local candidate report has Recall@5 `0.6667`, MRR@5 `0.5444`, no-answer accuracy `0.9444`, PL Recall@5/MRR@5 `0.4375`/`0.4375`, and holdout Recall@5/MRR@5/no-answer `0.6667`/`0.5`/`0.8333`. It fails the unchanged proposed quality thresholds. The 18 relevance cases and thresholds also require independent human approval. A production shadow pilot must not be used to bypass either failure.

## Exact approval inputs needed after TASK-013 passes

- immutable application/container SHA to deploy;
- target environment and deployment mechanism;
- approved HTTPS origins and production identity provider/audience;
- allowlisted tenant IDs and named internal cohort owner;
- monitoring/on-call owner and pilot window;
- privacy-safe sampling method, retention and deletion schedule;
- aggregate metrics destination and dashboard/alert ownership;
- error-budget and automatic-disable thresholds;
- rollback operator and rollback/disable command path;
- explicit authorization to deploy retrieval-only.

No corpus text, prompt text, embeddings, bearer tokens, retrieved PII or raw memory may enter logs, metrics or traces.

## Required immutable configuration

```text
RAG_RETRIEVAL_ENABLED=true
RAG_GENERATION_ENABLED=false
RAG_RESPONSE_ENABLED=false
RAG_ALLOWED_TENANTS=<explicit allowlist>
MEMORY_WRITE_ENABLED=false
MEMORY_RETRIEVAL_ENABLED=false
MEMORY_RESPONSE_ENABLED=false
```

The Qdrant endpoint and Mongo canonical store must remain private. The public API may execute aggregate shadow retrieval only after server-side identity derives tenant/project/ACL scope; request payloads cannot expand it.

## Pilot measurements and stop conditions

Measure aggregate retrieval latency, no-hit rate, errors/timeouts, fallback health, index/content versions, reconciliation lag and freshness. Human samples must use an approved privacy-safe process and may not expose unrelated tenant/user content.

Automatic stop/no-go conditions:

- any cross-tenant, cross-project, ACL, forbidden or stale hit;
- response payload changes while `RAG_RESPONSE_ENABLED=false`;
- generation traffic while `RAG_GENERATION_ENABLED=false`;
- missing/ambiguous corpus, index or application version;
- logging of prohibited content or credentials;
- unresolved canonical/projection drift;
- exceeded approved latency/error budget.

## Evidence required to close TASK-014

- deployment record tied to immutable SHA and target;
- verified flags and private dependency reachability;
- start/end timestamps, cohort and traffic volume;
- sanitized metric export plus reviewed human sample record;
- successful disable/rollback rehearsal;
- signed go/no-go decision;
- explicit separation of local tests, deployed runtime and production traffic evidence.
