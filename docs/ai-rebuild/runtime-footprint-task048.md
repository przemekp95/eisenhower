# TASK-048 runtime footprint evidence

Status: implementation and local CPU/image evidence complete; physical response lifecycle is characterized
and the dedicated knowledge ROCm runtime is selected after physical and all-severity security measurement. Governed holdout and deployment
gates remain open. Nothing in this report proves deployment, Mikrus capacity, production behavior or human
acceptance.

Source baseline: `a018f986fefae8a1add6c4c5f929da5320771fde`.
Initial role image source: `ed193ea3b14b655f805dbe4f143c1a7d2f9c5fe4`; latest measured ingest image
source: `76cfa9f8c4efe733ebba12742aa4da62827aa408`.

## Result

The public AI process is now a 248 MB HTTP/auth/audit boundary. Classification, online knowledge and
ingest/OCR/Docling have separate dependency targets and private role entrypoints. The default Compose graph
starts only core; retrieval, response, automation, identity/access and the former complete graph are explicit.
Production classification never trains and fails closed unless the mounted atomic generation pointer matches
the separately configured SHA-256.

Role entrypoints are explicit in Compose as well as in image CMDs, so an AMD image overlay cannot turn
knowledge or the SQLite worker back into the monolithic HTTP process. The builder no longer performs a model prefetch that was absent from the final image. Runtime model roles are
offline-only against mounted artifacts. Docling layout and TableFormer are prepared by an explicit offline
command into a 529,459,930-byte regular-file bundle; its complete file set, two immutable repository commits,
sizes and SHA-256 values are bound by manifest digest. The worker verifies it before constructing Docling and
mounts it read-only. The Unstructured spaCy model is a build dependency with the upstream SHA-256, avoiding a
hidden runtime installation. Existing cache revisions were not deleted or pruned.

## Before and after

All memory figures distinguish Docker working set from cgroup `memory.peak`. CPU figures are observations,
not proposed limits. The active baseline was not redeployed or recreated; only its two existing response
containers were later stopped and started for the explicitly recorded lifecycle characterization.

| Axis | Before, active `a018f986…` stack | After, isolated role split | Evidence boundary |
| --- | --- | --- | --- |
| CPU images | one 3.88 GB monolith, 10 layers | boundary 248 MB/10 layers; classifier 2.19 GB/13; knowledge 2.06 GB/13; ingest initially 3.86 GB/14, operational image 4.14 GB after required OpenCV GL runtime and pinned spaCy model | local Docker images; ingest growth is reported, not hidden |
| Layer sharing | one image | 50 layer references, 18 unique layers across four roles | local image metadata |
| Public AI dependency surface | full ML/OCR/Docling environment | boundary SBOM 124 components; no Torch, transformers, OCR or Docling | Trivy CycloneDX |
| Role SBOMs | not split | classifier 228, knowledge 166, initial ingest 373; operational ingest 403 components | Trivy CycloneDX |
| Fixed image findings | not freshly gated per role | selected knowledge PyTorch/ROCm: 0 LOW/MEDIUM/HIGH/CRITICAL; pinned upstream response vLLM: 181 LOW, 1,098 MEDIUM, 174 HIGH, 19 CRITICAL | Trivy 0.71.1 DB from 2026-08-15, `--ignore-unfixed`; response gate remains red |
| Hugging Face runtime cache | about 14.3 GiB | 14.3 GiB; no revision deleted | read-only mounted volume, `du` |
| BuildKit cache | 39.98 GB, 16.73 GB reclaimable | 50.11 GB, 26.85 GB reclaimable after candidate and exact-SHA builds | local builder; deliberately not pruned |
| AI boundary RAM | old monolith 136.1 MiB working set, 315 MiB cgroup peak | 42.22 MiB working set, 57.94 MiB cgroup peak | isolated liveness benchmark |
| Classifier RAM | included in monolith | 926.6 MiB working set, 1.01 GiB cgroup peak | approved artifact, cached MiniLM, one Torch/OMP thread |
| Knowledge RAM | active ROCm service 192.9 MiB working set, 5.82 GiB cgroup peak | CPU `hybrid-rrf-v1`: 762.8 MiB working set, 1.89 GiB cgroup peak | isolated read-only search; not ROCm evidence |
| Ingest RAM | active worker 98.86 MiB working set, 1.43 GiB cgroup peak | three 2 GiB repetitions: peak 1.84–2.11 GB, p95 2.10 GB, 0 max/OOM events; 512 MiB: exit 137, `OOMKilled=true` | isolated read-only 11-case extraction; no active stores or worker startup |
| Inference RAM | long-running 323–354 MiB working set, 13.53 GiB historical cgroup peak | 2.866 GiB five seconds after authenticated cold-wake; 278 PIDs | same exact baseline container; immediate post-wake and long-running working sets are not comparable |
| Reranker RAM | long-running 626–640 MiB working set, 6.27 GiB historical cgroup peak | 2.698 GiB five seconds after authenticated cold-wake; 278 PIDs | same exact baseline container; immediate post-wake and long-running working sets are not comparable |
| Boundary cold/warm | no comparable split baseline | cold live 0.775 s; warm p50 0.459 ms, p95 0.576 ms | 100 loopback liveness calls |
| Classifier cold/warm | no comparable exact-artifact baseline | cold first classification 6.113 s; warm p50 16.572 ms, p95 21.218 ms | 30 loopback requests, static benchmark auth only |
| Classifier failure | startup training was possible | absent approved pointer: HTTP 503 in 6.523 ms, no artifact created | production mode characterization |
| Knowledge cold/warm | active heterogeneous result not comparable | cold ready 6.667 s; warm search p50 134.618 ms, p95 159.244 ms | 20 CPU no-reranker searches; host had active GPU load |
| Ingest container-cold workload | no comparable frozen-container baseline | three 2 GiB runs: wall median 14.864 s/p95 15.482 s, CPU median 15.032 s, PID max 9; all 33 case executions passed | new process/container each run; host storage/page cache was not cold |
| Queue | unbounded producer/worker DB topology was inconsistent | capacity 128: enqueue p50 3.637 ms, p95 4.086 ms; overflow rejected in 0.122 ms; replay 0.074 ms | isolated SQLite microbenchmark |
| Physical response lifecycle | loaded: 100% GPU, 2.968 GB VRAM, 46.847 GB GTT, 64.024 W; stopped after 10 s: 5%, 2.983 GB, 2.775 GB, 26.049 W | stop 11.846 s; reranker ready 29.581 s; inference ready 116.086 s; both restored healthy | exact existing baseline containers, authenticated `/v1/models`, kernel sysfs and Docker stats; no recreate/deploy |
| Knowledge ROCm image | vLLM-derived: 10.684 GB OCI/33 layer refs; 26 layer digests shared with response vLLM | selected dedicated PyTorch: 10.614 GB/13 refs, 0 shared; aggregate unique digests rise 28 → 39; warm median regresses 44.73%; observed working set falls 5.017 → 3.417 GiB | one process-cold alternating physical pair; min embedding cosine 0.99999988; selection favors role isolation/security and is not a capacity qualification |
| Retrieval quality | dense recall@5 0.6964/MRR 0.5774/p95 25.93 ms; selected hybrid+reranker 0.9107/0.8048/266.83 ms | no-reranker 0.9107/0.7095/48.59 ms; rejected because global and PL MRR miss policy | fresh isolated 36-case non-holdout run; frozen holdout remains closed |

The classifier initially took 121.313 s because `sentence-transformers` performed unsuccessful Hugging Face
metadata requests despite a complete revision cache. Enforcing `HF_HUB_OFFLINE=1` and
`TRANSFORMERS_OFFLINE=1` reduced the same cold path to 6.113 s. Missing cache content now fails closed instead
of turning startup into an implicit downloader.

The ingest characterization exposed three hidden runtime requirements in sequence and retained each failure:
missing layout artifact (315.8 MB peak), missing `libGL.so.1` (844.9 MB peak), and an incomplete bundle missing
TableFormer (1.17 GB peak), followed by a hidden Unstructured spaCy installation attempt. The final 2 GiB run
completed all 11 frozen synthetic cases with zero cgroup pressure events. A 1 GiB diagnostic completed but
recorded 3,664 `memory.max` events and had a dirty evidence tree due to the preceding uncommitted report, so it
is informative only. The clean 512 MiB failure produced 3,774 `memory.max` events and a container OOM kill.
These are single-host synthetic measurements, not production limit recommendations.

A subsequent exact-image repetition set at source `090c1d5c` ran three clean reports for each of 2 GiB and
2.5 GiB. Both sets passed all 11 cases per run with zero pressure/OOM events. At 2 GiB the maximum cgroup peak
was 2,114,969,600 bytes, leaving only 32,514,048 bytes below the limit; wall p95 was 15.482 s. The later 2.5 GiB
set peaked at 1,837,862,912 bytes with wall p95 14.265 s, but it ran after the model and fixture files had warmed
the host page cache. Therefore the lower second peak is not attributed to the higher limit, neither set is a
true cold-host-storage benchmark, and no deployment limit was filled in. The committed aggregates bind each
of the six external raw reports by SHA-256.

The active vLLM 0.20 service confirmed that authenticated `/v1/score` returns 200, unauthenticated
`/v1/score` returns 401, while unauthenticated `/score` returns 200. The adapter therefore uses only
`/v1/score`. Direct vLLM development sleep routes are not enabled. The repository instead provides a private
Compose stop/start operator action with constant-time token validation, bounded authenticated readiness and
stop-on-timeout fallback. This follows the vLLM 0.20 [security guidance](https://docs.vllm.ai/en/v0.20.0/usage/security/)
and [sleep-mode documentation](https://docs.vllm.ai/en/v0.20.0/features/sleep_mode/).

The physical lifecycle rehearsal used `stop`/`start` on the exact deployed container IDs rather than current
branch `compose up`, which could have recreated a baseline container with unbuilt branch images. Stopping both
response engines reduced GTT by about 44.1 GB and board power by about 38 W while knowledge liveness remained
green. The repository wake action now attempts Compose `start` first and only creates missing containers as a
first-cold-start fallback. This measurement does not prove request-level application fallback, partial-start
cleanup, timeout cleanup or production behavior.

## Contract and architecture assessment

- HTTP and browser protection: Bearer/OIDC remains mandatory in production. The boundary accepts browser
  mutations only from the exact configured Origin, uses credential-free exact-origin CORS, never authenticates
  from client headers other than Bearer, forwards a narrow header set, bounds bodies and connection pools,
  applies finite connect/read/write/pool timeouts and rejects upstream redirects. Since browser credentials are
  not cookies, the CSRF defense is the Bearer plus exact-Origin model, not a synchronizer token. Private role
  URLs are fixed and validated; normal generation retains its application circuit breaker.
- Messaging, n8n, outbox and jobs: the Node/Mongo transactional outbox and its idempotency contract are
  unchanged. n8n and Calendar are externalized to explicit profiles, not replaced. HMAC webhook validation,
  replay protection, event idempotency, retry/dead-letter behavior and the single SQLite worker contract are
  retained; producer and worker now share the same volume and the queue is bounded with a 503/`Retry-After`
  ingress failure.
- CQRS and ports/adapters: commands/jobs remain separate from retrieval queries. Mongo is the canonical store;
  Qdrant is a rebuildable projection with reconciliation and rollback strategy. HTTP, MCP and job contracts use
  repository Pydantic/domain DTOs and port protocols; SentenceTransformer, Qdrant and vLLM types stay in
  adapters/composition roots.
- DDD: the repository has bounded vocabulary and clear domain/application/infrastructure separation for RAG,
  memory and document extraction, but the runtime is a layered/hexagonal hybrid rather than a fully modeled DDD
  system. Splitting deployable roles does not create new domain bounded contexts.
- TDD: this slice has direct red/green evidence for missing fail-closed artifact handling, queue capacity, role
  targets/profiles, authenticated vLLM paths, browser Origin rejection, lifecycle timeout fallback, build-tool
  CVEs and offline cache behavior. The wider repository's test presence alone does not prove historical TDD.
- BDD: no Gherkin, executable feature scenarios or living Given/When/Then specification was found for this
  slice. Unit, integration and Compose contract tests are not labeled as BDD evidence.

## Verification

- focused red/green tests for each implementation slice;
- final backend AI and local deployment suite after the lifecycle follow-up: 697 passed, 11 skipped, coverage
  85.50%;
- production dependency audit: 171 dependencies; exact official PyTorch CPU wheel sources and SHA-256 values
  verified for the two explicit audit blind spots;
- four exact-SHA role builds, CycloneDX SBOMs and role vulnerability scans;
- rebuilt operational ingest image at exact source `76cfa9f8…`: OCI role/revision labels matched, CycloneDX
  contained 403 components, and Trivy 0.71.1 found 0 fixed HIGH/CRITICAL vulnerabilities;
- Compose renders for core, retrieval, response and full using explicit non-production fixture values;
- isolated non-holdout retrieval comparison at source `2d128d0a`: output SHA-256
  `9e2af89e03699d7b357f002185ae59caf4de3a3a08edd2c51d3f9647b2a64af3`, with its UUID Mongo database
  dropped and Qdrant collection deleted after the run;
- shell syntax and local production contract tests.
- deterministic Docling artifact preparation plus isolated cgroup-v2 ingest evidence for successful 2 GiB and
  OOM-killed 512 MiB runs; neither accessed active MongoDB, Qdrant or the GPU.
- six additional clean exact-image ingest repetitions aggregated into comparable 2 GiB and 2.5 GiB summaries;
  all 66 case executions passed and raw report SHA-256 values are retained, while host-cache order remains an
  explicit confounder.
- exact-container physical gfx1151 response stop/start: authenticated ready in 29.581 s for reranker and
  116.086 s for inference, both restored healthy; no image or Compose recreation occurred.
- the pinned official PyTorch/ROCm knowledge experiment built on gfx1151, passed `pip check`, emitted a
  772-component SBOM and had zero fixed LOW/MEDIUM/HIGH/CRITICAL findings after package updates. Its embeddings
  matched the vLLM-derived baseline (minimum cosine 0.99999988). The exact selected build at source
  `7117a5d1…` repeated `pip check`, the 772-component SBOM and the zero-fixed-finding all-severity gate. It is
  selected for knowledge despite a 44.73% warm-median regression and aggregate unique layer growth from 28 to
  39, because the alternative carried vulnerable vLLM code that this role does not use.
- the separately pinned upstream vLLM 0.20.x response image remains selected for inference and reranking only.
  Its fresh all-severity scan found 1,472 fixed findings (181 LOW, 1,098 MEDIUM, 174 HIGH, 19 CRITICAL), so it
  remains an explicit red release gate; no deployment or risk acceptance occurred.
- legacy monolith Compose snapshots from source `a018f986…` render successfully with their exact image IDs;
  the role-split rollback contract now stores and SHA-verifies those source-revision configs. The mutating
  migration/rollback rehearsal remains separately authorized work.

## Open gates and risks

1. The dedicated pinned PyTorch/ROCm image is selected for knowledge after the full severity scan. It does not
   eliminate vLLM: generation and reranking still use the pinned private vLLM 0.20.x response image. That
   upstream image currently fails the fixed LOW/MEDIUM/HIGH/CRITICAL gate, including 19 CRITICAL findings.
   Do not publish or deploy it without a patched compatible image or an explicit, evidence-backed exception.
   The knowledge selection also adds unique cache layers and regresses warm latency; no disk or power saving is
   claimed until repeated capacity measurements exist.
2. Calibrate every mandatory CPU/RAM/PID/thread value, especially both vLLM services, using repeated
   representative workloads. Ingest now has one clean success and one deliberate OOM boundary, but not enough
   repetitions or production-shaped documents to set a deployment limit. `.env.example` remains blank.
3. A fresh directional comparison on the explicitly unapproved 36-case non-holdout rejected simplification:
   no-reranker kept recall@5 at 0.9107 and cut p95 from 266.83 ms to 48.59 ms, but global MRR fell from 0.8048
   to 0.7095 and PL MRR from 0.8000 to 0.5952. Do not tune on or promote from this data. A governed frozen
   holdout run still requires human authorization; the default remains `hybrid-bge-v1` and
   `hybrid-rrf-v1` is only a rollbackable candidate.
4. The exact-container physical sleep/wake path passed locally. Request fallback, forced cold-wake timeout,
   partial-start cleanup and OOM recovery remain unqualified; deliberately inducing them on the active stack
   requires a separately scoped disruption rehearsal.
5. The first role-split rollback now preserves SHA-verified legacy Compose snapshots and the exact monolith
   image IDs, closing the implementation gap. A real deployment/rollback remains unexecuted because this task
   explicitly withholds deployment authority.
6. Size Prometheus storage before adding a TSDB byte limit. Retention time is already bounded; guessing a byte
   cap without cardinality/storage evidence would create an avoidable outage risk.
