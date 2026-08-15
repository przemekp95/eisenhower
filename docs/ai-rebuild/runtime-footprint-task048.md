# TASK-048 runtime footprint evidence

Status: implementation, isolated-image evidence, the one-shot governed holdout and the authorized local
gfx1151 lifecycle/rollback rehearsal are complete. The dedicated knowledge ROCm runtime and the vLLM 0.26
response runtime are selected after physical and all-severity security measurement. Nothing in this report
proves a branch deployment, Mikrus capacity, production behavior or permanent human acceptance.

Source baseline: `a018f986fefae8a1add6c4c5f929da5320771fde`.
Initial role image source: `ed193ea3b14b655f805dbe4f143c1a7d2f9c5fe4`; latest measured ingest image
source: `76cfa9f8c4efe733ebba12742aa4da62827aa408`; response-image source:
`53f741cd77fca49d1932ebea42b77af998e1f06b`.

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
| Fixed image findings | upstream vLLM 0.20: 1,472 fixed findings | selected knowledge PyTorch/ROCm: 0; exact response vLLM 0.26: 4 raw (1 LOW, 1 MEDIUM, 2 HIGH), 0 applicable after exact-image OpenVEX | Trivy 0.71.1 DB from 2026-08-15, `--ignore-unfixed`; exact response gate is green, not a blanket upstream exception |
| Hugging Face runtime cache | about 14.3 GiB | 14.3 GiB; no revision deleted | read-only mounted volume, `du` |
| BuildKit cache | 39.98 GB, 16.73 GB reclaimable | 50.11 GB, 26.85 GB reclaimable after candidate and exact-SHA builds | local builder; deliberately not pruned |
| AI boundary RAM | old monolith 136.1 MiB working set, 315 MiB cgroup peak | 42.22 MiB working set, 57.94 MiB cgroup peak | isolated liveness benchmark |
| Classifier RAM | included in monolith | 926.6 MiB working set, 1.01 GiB cgroup peak | approved artifact, cached MiniLM, one Torch/OMP thread |
| Knowledge RAM | active ROCm service 192.9 MiB working set, 5.82 GiB cgroup peak | CPU `hybrid-rrf-v1`: 762.8 MiB working set, 1.89 GiB cgroup peak | isolated read-only search; not ROCm evidence |
| Ingest RAM | active worker 98.86 MiB working set, 1.43 GiB cgroup peak | three 2 GiB repetitions: peak 1.84–2.11 GB, p95 2.10 GB, 0 max/OOM events; 512 MiB: exit 137, `OOMKilled=true` | isolated read-only 11-case extraction; no active stores or worker startup |
| Inference RAM/CPU/PID limit | long-running 323–354 MiB working set, 13.53 GiB historical cgroup peak; unbounded by role | 16 GiB, 3 CPU, 320 PID; fresh sequential wake peak 7,153,188,864 bytes and 249 PIDs, zero `memory.max`/OOM events | exact vLLM 0.26 image on physical gfx1151; the first 4 GiB attempt failed readiness without OOM and was not hidden |
| Reranker RAM/CPU/PID limit | long-running 626–640 MiB working set, 6.27 GiB historical cgroup peak; unbounded by role | 6 GiB, 3 CPU, 350 PID; fresh sequential wake peak 4,499,148,800 bytes and 280 PIDs, zero `memory.max`/OOM events | exact vLLM 0.26 image; 5 GiB reached `memory.max`, so it was rejected |
| Boundary cold/warm | no comparable split baseline | cold live 0.775 s; warm p50 0.459 ms, p95 0.576 ms | 100 loopback liveness calls |
| Classifier cold/warm | no comparable exact-artifact baseline | cold first classification 6.113 s; warm p50 16.572 ms, p95 21.218 ms | 30 loopback requests, static benchmark auth only |
| Classifier failure | startup training was possible | absent approved pointer: HTTP 503 in 6.523 ms, no artifact created | production mode characterization |
| Knowledge cold/warm | active heterogeneous result not comparable | cold ready 6.667 s; warm search p50 134.618 ms, p95 159.244 ms | 20 CPU no-reranker searches; host had active GPU load |
| Ingest container-cold workload | no comparable frozen-container baseline | three 2 GiB runs: wall median 14.864 s/p95 15.482 s, CPU median 15.032 s, PID max 9; all 33 case executions passed | new process/container each run; host storage/page cache was not cold |
| Queue | unbounded producer/worker DB topology was inconsistent | capacity 128: enqueue p50 3.637 ms, p95 4.086 ms; overflow rejected in 0.122 ms; replay 0.074 ms | isolated SQLite microbenchmark |
| Physical response lifecycle | loaded baseline: 100% GPU, 2.968 GB VRAM, 46.847 GB GTT, 64.024 W; stopped after 10 s: 5%, 2.983 GB, 2.775 GB, 26.049 W | vLLM 0.26 clean sequential wake: reranker 47–71 s, inference 111–157 s; stop released 48.884 GB GTT and about 22 W; final VRAM 2.935 GB, GTT 51.737 GB, power 57.023 W | private authenticated stop/start on physical gfx1151; integrated-GPU VRAM alone understates released memory |
| Knowledge ROCm image | vLLM-derived: 10.684 GB OCI/33 layer refs; 26 layer digests shared with response vLLM | selected dedicated PyTorch: 10.614 GB/13 refs, 0 shared; aggregate unique digests rise 28 → 39; warm median regresses 44.73%; observed working set falls 5.017 → 3.417 GiB | one process-cold alternating physical pair; min embedding cosine 0.99999988; selection favors role isolation/security and is not a capacity qualification |
| Retrieval quality | non-holdout selected hybrid+reranker 0.9107 recall@5/0.8048 MRR/266.83 ms p95 | one-shot frozen holdout: both variants 0.6667 recall@5 and MRR, 0.8333 no-answer accuracy; reranker 252.996 ms p95 vs 54.250 ms without; both fail policy, so simplification is rejected | six PL/EN cases, zero forbidden/stale/isolation findings; source/receipt/marker bound and stores cleaned |

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

The response roles now use official vLLM 0.26.0 on ROCm, wrapped in an exact-source image ID
`sha256:8abffc236624…` (11,169,938,013 bytes). Qwen generation, the pinned BGE scoring contract,
authenticated `/v1/models` and `/v1/score`, serialized `max-num-seqs=1`, oversized-request rejection and
cold/warm requests passed on physical gfx1151. vLLM is deliberately not used for the knowledge role, whose
selected pinned PyTorch/ROCm image avoids carrying unused server code. This is a bounded, compatible response
upgrade rather than a rewrite of the OpenAI-compatible port.

Direct vLLM development sleep routes are not enabled: v0.26 still requires development mode and the official
security guidance excludes that mode from production. The repository uses private Compose stop/start with
constant-time operator authorization, a shared worktree-safe lifecycle mutex, per-probe connect/total
timeouts, a total wake deadline, sequential reranker/inference readiness and stop-on-any-partial-failure.
See the current v0.26 [sleep-mode documentation](https://docs.vllm.ai/en/v0.26.0/features/sleep_mode/) and
[security guidance](https://docs.vllm.ai/en/stable/usage/security/).

The final lifecycle rehearsal recreated only the two local response containers, not the branch application
stack. It first rolled the exact vLLM 0.26 image back to the retained v0.20 image ID, verified authenticated
readiness (62 s reranker, 137 s inference), 401 without Bearer, zero OOM/restarts and the same limits, then
restored exact v0.26 (71 s/157 s) with the same green checks. Earlier clean v0.26 wake evidence was 47 s/111 s;
the range is retained instead of selecting the fastest run. This proves a local rollback mechanism and its
retained image, not a production rollout or rollback.

The time-bounded owner acceptance for the frozen retrieval holdout expired at
`2026-08-15 23:59:59 Europe/Warsaw` (`UTC+02:00`), consistently with the other conditional acceptances. The
runner consumed it exactly once before expiry. A receipt-digest marker in the Git common directory prevents
replay from another path or worktree. The report is bound to source `e4e824fa…`; its isolated Mongo database
and Qdrant collection were removed after scoring. No missing human case labels or 42 decisions were invented.

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
- final backend AI suite after the lifecycle follow-up: 700 passed, 11 skipped, backend coverage 85.57%; local
  production contract: 24 passed; shell syntax and diff checks: green;
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
- exact vLLM 0.26 response image: vLLM 0.26.0, Torch 2.11.0, HIP 7.2; physical gfx1151 generation/scoring,
  queue serialization, oversize rejection, bounded resources and sequential stop/wake passed. The first 4 GiB
  inference and 5 GiB reranker candidates were rejected from measured failure/pressure evidence.
- the pinned official PyTorch/ROCm knowledge experiment built on gfx1151, passed `pip check`, emitted a
  772-component SBOM and had zero fixed LOW/MEDIUM/HIGH/CRITICAL findings after package updates. Its embeddings
  matched the vLLM-derived baseline (minimum cosine 0.99999988). The exact selected build at source
  `7117a5d1…` repeated `pip check`, the 772-component SBOM and the zero-fixed-finding all-severity gate. It is
  selected for knowledge despite a 44.73% warm-median regression and aggregate unique layer growth from 28 to
  39, because the alternative carried vulnerable vLLM code that this role does not use.
- the separately pinned vLLM 0.20.x image remains only as the physically rehearsed rollback. The selected exact
  vLLM 0.26 response image emitted a 1,881-component SBOM. Its raw scan contained four fixed findings. Exact
  OCI-PURL OpenVEX marks the three unreachable Python build/extraction paths and the Torch finding whose NVD
  affected configuration is 2.6.0 rather than installed 2.11.0 as not affected; Trivy then reports zero
  remaining findings at LOW/MEDIUM/HIGH/CRITICAL. This VEX is image-specific, reviewable and not transferable.
- the one-shot frozen holdout receipt SHA-256 is
  `132c878322ae75fa3bc8bbb3199ae4ca723b607ce43070cf7f13cf4d1a573ef3`; the aggregate evidence SHA-256 is
  `4a4341b40bba6be06b610491236c6ce3e7bfc08125f679b7b512204f3dc89f1c`. Both variants failed the declared quality policy, so the cheaper no-reranker candidate was
  rejected and `hybrid-bge-v1` remains selected and available as rollback.
- legacy monolith Compose snapshots from source `a018f986…` render successfully with exact image IDs. The
  response-only rollback rehearsal actually switched local containers v0.26 → exact v0.20 → exact v0.26 and
  restored health/auth/limits. No branch deploy, promotion, merge or production mutation occurred.

## Open gates and risks

1. vLLM remains the cost-optimal selected response runtime because v0.26 preserved the existing private
   OpenAI/scoring contracts and physical gfx1151 behavior without a service rewrite. Knowledge uses the
   dedicated PyTorch/ROCm runtime because it does not need a public vLLM server. The knowledge selection adds
   unique cache layers and regresses warm latency; no disk or power saving is claimed without more repetitions.
2. Inference and reranker have measured limits, but ingest still lacks production-shaped/cold-storage documents
   sufficient to choose a production limit. The measured response defaults do not establish Mikrus capacity.
3. Both frozen-holdout variants failed the policy. The no-reranker variant is faster but is not promoted;
   `hybrid-bge-v1` remains selected/rollbackable. The time-bounded owner acceptance is expired and the receipt
   cannot be replayed; a future quality decision needs a newly authorized, independently governed evaluation.
4. The exact-container private sleep/wake, partial cleanup, mutex, bounded readiness and v0.20 rollback paths
   are implemented and locally verified. A source deploy of this branch, full monolith-to-role rollback,
   production concurrency and forced hardware OOM remain outside the evidence boundary.
5. Exact-image VEX makes the local vLLM 0.26 scan green, but any base/package/image change invalidates that
   evidence and must regenerate SBOM, raw scan, applicability analysis and adjusted scan.
6. Size Prometheus storage before adding a TSDB byte limit. Retention time is already bounded; guessing a byte
   cap without cardinality/storage evidence would create an avoidable outage risk.
