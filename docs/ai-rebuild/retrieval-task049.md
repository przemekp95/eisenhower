# TASK-049 — retrieval without a separate reranker

## Decision

Keep `hybrid-bge-v1` and its private pinned vLLM score service as the selected rollback-safe strategy.
The cheaper candidates materially reduced query time but none passed the frozen multilingual quality and
no-answer policy. No validation seed was revealed, no promotion pointer or Compose default changed, and no
deployment or production state was modified.

This is not a security-gate failure. All measured candidates kept forbidden, stale, cross-scope and duplicate
hit rates at zero. The failed axis is answerability quality: raising the dense threshold improves abstention
only by discarding valid Polish and English semantic matches.

## What was tried

1. BGE-M3 dense at four calibrated thresholds.
2. Existing dense plus canonical Mongo BM25 with weighted RRF.
3. Project-owned DBSF score fusion with three dense/lexical weight ratios; it stays behind the existing
   `Retriever` port as an unselected shadow candidate.
4. Native BGE-M3 sparse weights in a separate named Qdrant projection and atomic alias. Only the official
   `sparse_linear.pt` from pinned model revision `5617a9f…` is required; its SHA-256 is
   `45c93804…3595ad9`. The large FlagEmbedding training/dependency stack was not added.

The excluded fourth solution from the user discussion — a new separate cross-encoder or ColBERT service — was
not implemented. The existing reranker was not used for calibration selection and remains only the incumbent
rollback target.

## Frozen evidence

The calibration and validation seeds were committed by SHA-256 before execution. Calibration used 96 synthetic
PL/EN cases with exact IDs, semantic-only paraphrases, lexical confusables, multi-document answers and four
no-answer/isolation categories. The consumed TASK-048 holdout and earlier comparison packets were guarded
against query overlap. Validation stayed sealed because calibration produced no eligible challenger.

On the selected dedicated PyTorch/ROCm image `sha256:2e824d…`, the best score-fusion candidate reached
Recall@5 0.8594, MRR 0.8516 and 109.67 ms p95, but no-answer accuracy was only 0.6042. Dense at threshold 0.55
reached 0.8281/0.8047 and 115.63 ms p95 with no-answer 0.7604. Sparse-only answerable quality was
0.9062/0.8646, while dense+sparse RRF regressed from raw dense 0.9844/0.9089 to 0.9531/0.8885. The best
zero-false-positive confidence rule accepted only 56/64 answerable cases (0.875), below the 0.90 gate.

The selected image cold model load was 157.03 s and process peak RSS was 3068.26 MiB under an 8 GiB / 4 CPU /
256 PID / two-thread calibration cgroup. External samples during physical gfx1151 load showed roughly
2.65 GiB total VRAM, 100% GPU busy and 58–66 W; these are samples, not a per-process VRAM/power attribution.

## Before / after

| Axis | Before | After TASK-049 | Evidence boundary |
|---|---:|---:|---|
| Selected retrieval | `hybrid-bge-v1` + private reranker | unchanged | local source/config only; not redeployed |
| Historical reranker p95 | 252.996 ms | unchanged incumbent | older TASK-048 frozen packet |
| Historical no-reranker p95 | 54.250 ms | not promoted | older MiniLM packet; not comparable to BGE-M3 |
| Fresh BGE-M3 score-fusion p95 | not measured on new packet | 109.672 ms | selected physical image, calibration split |
| Fresh Recall@5 / MRR | not measured on new packet | 0.8594 / 0.8516 | score-fusion candidate; below gate |
| Fresh no-answer accuracy | not measured on new packet | 0.6042 | required 1.0; below gate |
| Knowledge image | 10,613,987,777 B, 13 layers | unchanged | selected dedicated image |
| Knowledge SBOM / fixed findings | 772 / 0 | 772 / 0 | fresh Trivy CycloneDX and all-severity fixed scan |
| Model cache | pinned BGE-M3 revision | unchanged; optional 3.5 KiB sparse head measured externally | no rollback revision deleted |
| Calibration RAM | not measured on this packet | 3068.26 MiB peak RSS | container process peak |
| Calibration CPU / PID | unbounded old service | capped 4 CPU / 256 PID; sampled ~1 CPU / 8–12 PID | benchmark cgroup, not deployed limit |
| GPU / VRAM / power | shared physical gfx1151 | sampled 100% / ~2.65 GiB total / 58–66 W | shared-device sample, not per-process |
| Active reranker idle RAM | ~3.12 GiB current container | unchanged | fresh `docker stats`; removal was rejected |
| Production/public state | unchanged | unchanged | no merge, push, deploy or public endpoint |

## Architecture and methodology assessment

- HTTP, MCP and jobs keep project-owned types; no SentenceTransformers, Torch, Qdrant or FlagEmbedding type
  enters transport contracts. Bearer/OIDC, private service URLs, timeouts and existing circuit/fallback behavior
  are unchanged.
- Mongo remains canonical and both dense and sparse Qdrant collections are rebuildable projections. Sparse
  diagnostics used a versioned collection plus alias and verified deletion; there was no in-place schema change.
- n8n, HMAC webhooks, transactional outbox, idempotency, retry/dead-letter, SQLite jobs and CQRS command/query
  paths were untouched. No event-bus claim is inferred from the existing outbox/jobs.
- Exact Origin/CORS/CSRF/browser protections were unaffected because this slice added no browser or HTTP route.
- Ports-and-adapters remains the accurate description of the retrieval boundary. The RAG area has useful domain
  language and canonical/application/infrastructure separation, but the repository is hybrid layered/DDD rather
  than a fully isolated DDD bounded-context implementation.
- Red tests preceded DBSF, sealed dataset/gates, confidence diagnostics and sparse-head code. This proves the
  local red-green slices, not organization-wide TDD adoption. Existing executable Cucumber scenarios are BDD
  evidence elsewhere; TASK-049 itself added no new Gherkin and ordinary pytest is not relabeled as BDD.

## Verification and open risks

- `730 passed, 11 skipped`, 87.96% backend-AI coverage; focused TASK-049 suites and Pylint 10.00/10 passed.
- 24 local Compose/render contracts, shell syntax and `git diff --check` passed.
- Fresh selected-image SBOM: 772 components; fixed LOW/MEDIUM/HIGH/CRITICAL findings: zero.
- Raw reports remain runner-local under `/mnt/data/cache/codex` and are bound by hashes in
  `backend-ai/evaluation/retrieval-task049-v1/outcome.json`.

Open risks: the synthetic packet does not replace independent real-domain human labels; shared-GPU power/VRAM
cannot be attributed per container; the active old local service is not proof that the selected image or source
was deployed; and reranker RAM/VRAM remains the price of meeting current quality. A future removal attempt needs
new representative no-answer labels or a materially stronger single-stage retriever, not a relaxed gate.
