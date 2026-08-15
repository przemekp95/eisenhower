# TASK-048 runtime footprint evidence

Status: implementation and local CPU/image evidence complete; physical ROCm, governed holdout and deployment
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

The builder no longer performs a model prefetch that was absent from the final image. Runtime model roles are
offline-only against mounted artifacts. Docling layout and TableFormer are prepared by an explicit offline
command into a 529,459,930-byte regular-file bundle; its complete file set, two immutable repository commits,
sizes and SHA-256 values are bound by manifest digest. The worker verifies it before constructing Docling and
mounts it read-only. The Unstructured spaCy model is a build dependency with the upstream SHA-256, avoiding a
hidden runtime installation. Existing cache revisions were not deleted or pruned.

## Before and after

All memory figures distinguish Docker working set from cgroup `memory.peak`. CPU figures are observations,
not proposed limits. The active before stack was not restarted or changed.

| Axis | Before, active `a018f986…` stack | After, isolated candidate | Evidence boundary |
| --- | --- | --- | --- |
| CPU images | one 3.88 GB monolith, 10 layers | boundary 248 MB/10 layers; classifier 2.19 GB/13; knowledge 2.06 GB/13; ingest initially 3.86 GB/14, operational image 4.14 GB after required OpenCV GL runtime and pinned spaCy model | local Docker images; ingest growth is reported, not hidden |
| Layer sharing | one image | 50 layer references, 18 unique layers across four roles | local image metadata |
| Public AI dependency surface | full ML/OCR/Docling environment | boundary SBOM 124 components; no Torch, transformers, OCR or Docling | Trivy CycloneDX |
| Role SBOMs | not split | classifier 228, knowledge 166, initial ingest 373; operational ingest 403 components | Trivy CycloneDX |
| HIGH/CRITICAL image findings | not freshly gated per role | 0/0 for every exact-SHA role after patching vendored build tooling | Trivy 0.71.1 DB from 2026-08-15, `--ignore-unfixed` |
| Hugging Face runtime cache | about 14.3 GiB | 14.3 GiB; no revision deleted | read-only mounted volume, `du` |
| BuildKit cache | 39.98 GB, 16.73 GB reclaimable | 50.11 GB, 26.85 GB reclaimable after candidate and exact-SHA builds | local builder; deliberately not pruned |
| AI boundary RAM | old monolith 136.1 MiB working set, 315 MiB cgroup peak | 42.22 MiB working set, 57.94 MiB cgroup peak | isolated liveness benchmark |
| Classifier RAM | included in monolith | 926.6 MiB working set, 1.01 GiB cgroup peak | approved artifact, cached MiniLM, one Torch/OMP thread |
| Knowledge RAM | active ROCm service 192.9 MiB working set, 5.82 GiB cgroup peak | CPU `hybrid-rrf-v1`: 762.8 MiB working set, 1.89 GiB cgroup peak | isolated read-only search; not ROCm evidence |
| Ingest RAM | active worker 98.86 MiB working set, 1.43 GiB cgroup peak | 2 GiB limit: 1.90 GiB sampled / 1.90 GiB cgroup peak, 0 max/OOM events; 512 MiB: exit 137, `OOMKilled=true` | isolated read-only 11-case extraction; no active stores or worker startup |
| Inference RAM | 354 MiB working set, 13.53 GiB cgroup peak | not restarted or scaled to zero | active vLLM observation only |
| Reranker RAM | 626.8 MiB working set, 6.27 GiB cgroup peak | not restarted or scaled to zero | active vLLM observation only |
| Boundary cold/warm | no comparable split baseline | cold live 0.775 s; warm p50 0.459 ms, p95 0.576 ms | 100 loopback liveness calls |
| Classifier cold/warm | no comparable exact-artifact baseline | cold first classification 6.113 s; warm p50 16.572 ms, p95 21.218 ms | 30 loopback requests, static benchmark auth only |
| Classifier failure | startup training was possible | absent approved pointer: HTTP 503 in 6.523 ms, no artifact created | production mode characterization |
| Knowledge cold/warm | active heterogeneous result not comparable | cold ready 6.667 s; warm search p50 134.618 ms, p95 159.244 ms | 20 CPU no-reranker searches; host had active GPU load |
| Ingest cold workload | no comparable frozen-container baseline | 15.288 s wall, 14.917 CPU-s, peak 7 PID; all 11 required phrase checks passed | PDF/DOCX/PPTX/HTML primary+fallback and approved OCR, one isolated run |
| Queue | unbounded producer/worker DB topology was inconsistent | capacity 128: enqueue p50 3.637 ms, p95 4.086 ms; overflow rejected in 0.122 ms; replay 0.074 ms | isolated SQLite microbenchmark |
| Active GPU | 100% use, 3.16 GB VRAM, 70.083 W; inference and reranker each near 101% host CPU | no after measurement | scale-to-zero code/tests are not a physical wake/sleep result |
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

The active vLLM 0.20 service confirmed that authenticated `/v1/score` returns 200, unauthenticated
`/v1/score` returns 401, while unauthenticated `/score` returns 200. The adapter therefore uses only
`/v1/score`. Direct vLLM development sleep routes are not enabled. The repository instead provides a private
Compose stop/start operator action with constant-time token validation, bounded authenticated readiness and
stop-on-timeout fallback. This follows the vLLM 0.20 [security guidance](https://docs.vllm.ai/en/v0.20.0/usage/security/)
and [sleep-mode documentation](https://docs.vllm.ai/en/v0.20.0/features/sleep_mode/).

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
- final backend AI and local deployment suite after the Docling follow-up: 689 passed, 11 skipped, coverage
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

## Open gates and risks

1. Run clean physical gfx1151/ROCm cold/warm/idle/peak/OOM/wake measurements without the current inference and
   reranker load. Until then the ROCm knowledge service remains on the existing vLLM-derived image and no GPU,
   VRAM, power or image saving is claimed.
2. Calibrate every mandatory CPU/RAM/PID/thread value, especially both vLLM services, using repeated
   representative workloads. Ingest now has one clean success and one deliberate OOM boundary, but not enough
   repetitions or production-shaped documents to set a deployment limit. `.env.example` remains blank.
3. A fresh directional comparison on the explicitly unapproved 36-case non-holdout rejected simplification:
   no-reranker kept recall@5 at 0.9107 and cut p95 from 266.83 ms to 48.59 ms, but global MRR fell from 0.8048
   to 0.7095 and PL MRR from 0.8000 to 0.5952. Do not tune on or promote from this data. A governed frozen
   holdout run still requires human authorization; the default remains `hybrid-bge-v1` and
   `hybrid-rrf-v1` is only a rollbackable candidate.
4. Physically exercise `sleep-response`/`wake-response`, cold-wake timeout, partial-start cleanup and request
   fallback. Unit tests and render proof do not establish GPU lifecycle behavior.
5. Qualify the first role-split deployment rollback from the monolithic topology. Later exact-SHA role rollback
   is recorded, but the migration boundary still needs an operator rehearsal.
6. Size Prometheus storage before adding a TSDB byte limit. Retention time is already bounded; guessing a byte
   cap without cardinality/storage evidence would create an avoidable outage risk.
