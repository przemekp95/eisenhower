# TASK-050 — confidence-gated retrieval without a separate reranker

## Decision

Retain `hybrid-bge-v1` and its private pinned reranker. TASK-050 fixed the evaluation defect that applied one
threshold to incomparable dense cosine and BM25 score scales, added a post-fusion confidence candidate and
required structured identifiers to be present in canonical evidence. The candidate materially improved the
tuning split, but the independently seeded qualification packet failed the frozen answerability and latency
gates. The original TASK-049 validation seed remained sealed and no runtime pointer, Compose default,
deployment or production state changed.

This is not a security-gate failure. Forbidden, stale, cross-scope and duplicate hit rates remained zero. The
failure is quality: eight Polish semantic paraphrases and one English paraphrase were missed, while three
unstructured English no-answer questions still received unrelated evidence. Tuning further on the observed
qualification packet would invalidate it, so the attempt stops here.

## Test-first slices and measured outcome

The first red test required an explicit structured identifier in returned canonical title/text rather than
accepting a semantic substitute. The second red test required source-native dense/BM25 confidence after scope
validation and proved that the candidate reads unthresholded bounded source rankings before applying its final
abstention decision. The third red test rejected dense similarity with no lexical evidence. Each test was red
before its implementation and green afterward; this proves these local TDD slices, not repository-wide TDD.

Development v1 reached Recall@5 `0.9688`, MRR `0.9297`, no-answer accuracy `0.9519` and p95 `120.84 ms`.
Those observations changed only the predeclared v2 policy. The subsequently committed, independently seeded
single-use qualification produced Recall@5 `0.8594`, MRR `0.8594`, no-answer accuracy `0.8942` and p95
`134.77 ms`; PL Recall@5/MRR were `0.75/0.75`. It therefore failed the unchanged global recall `0.90`, PL
recall `0.85`, no-answer `1.0` and p95 `125 ms` gates. Validation was not opened.

## Before / after

| Axis | Before TASK-050 | TASK-050 result | Decision boundary |
|---|---:|---:|---|
| Selected retrieval | `hybrid-bge-v1` + reranker | unchanged | no promotion or deployment |
| Historical selected p95 | 252.996 ms | unchanged | older TASK-048 frozen packet |
| TASK-049 best no-reranker | 0.8594 Recall / 0.8516 MRR / 0.6042 no-answer / 109.67 ms | superseded as experiment only | physical calibration |
| TASK-050 dev v1 | not available | 0.9688 / 0.9297 / 0.9519 / 120.84 ms | tuning split only |
| TASK-050 qualification v2 | not available | 0.8594 / 0.8594 / 0.8942 / 134.77 ms | independent single-use packet; failed |
| Security/isolation rates | all zero | all zero | ACL and canonical revalidation preserved |
| Knowledge image | 10,613,987,777 B / 13 layers | unchanged | exact selected dependency image |
| Image SBOM / fixed findings | 772 / 0 | 772 / 0 | fresh CycloneDX and fixed-vulnerability scan |
| Candidate cold load / peak RSS | 157.03 s / 3068.26 MiB | 159.91 s / 3557.84 MiB | 8 GiB, 4 CPU, 256 PID, two threads |
| Active reranker idle RAM | about 3.12 GiB | 3.064 GiB fresh sample | remains the quality cost |
| Shared GPU sample after run | not attributable per process | 100% busy / 2.66 GiB VRAM / 61 W | inference and reranker were also active |
| Model/cache revisions | pinned BGE-M3 plus retained rollback revisions | unchanged | no cache or rollback revision deleted |
| Production/public state | unchanged | unchanged | no push, merge, deploy or public endpoint |

The confidence candidate was exercised by bind-mounting exact clean source into the previously selected
PyTorch/ROCm dependency image. That proves local physical behavior but is not a newly built or deployable image.
The unchanged selected image was freshly rescanned; no image-size saving is claimed because the reranker remains.

## Architecture and contracts

- HTTP and MCP contracts remain project-owned. Bearer/OIDC, private HTTP, timeouts, circuit behavior,
  exact-Origin/CORS/CSRF browser protections and public routes were unchanged.
- The gate runs after canonical ACL/scope validation behind the existing `Retriever` port. Mongo remains the
  canonical source; Qdrant remains a rebuildable projection. No Torch, Qdrant or framework type enters a port,
  HTTP, MCP or job contract.
- n8n/HMAC webhooks, transactional outbox, idempotency, retry/dead-letter and bounded SQLite jobs were untouched.
  The repository retains a pragmatic command/query separation; this slice adds no message bus and does not claim
  full CQRS.
- Ports-and-adapters remains accurate for retrieval. The RAG code has bounded domain language and application /
  infrastructure separation, but the repository remains hybrid layered/DDD rather than a fully isolated DDD
  bounded context.
- Existing Cucumber scenarios remain BDD evidence elsewhere. TASK-050 added behavior-named pytest tests, not new
  Gherkin or living BDD documentation.

## Verification and open risks

- Focused: `57 passed`; full backend AI: `745 passed, 11 skipped`, 88.03% coverage; Pylint `10.00/10`.
- Local production contracts: `24 passed`; core, retrieval, response and full Compose renders passed using a
  temporary render-only environment. The two exact temporary files were unlinked after rendering.
- Fresh selected-image SBOM: 772 components; fixed LOW/MEDIUM/HIGH/CRITICAL findings: zero.
- Both physical runs verified isolated Mongo database and Qdrant collection cleanup. Raw reports remain local
  under `/mnt/data/cache/codex` and are hash-bound in the outcome record.

Open risks: synthetic packets do not replace representative independent human labels; the shared GPU sample is
not per-container attribution; the optional confidence policy is not selected or deployed; and the reranker's
RAM/VRAM remains necessary under current evidence. A future removal attempt needs a materially stronger
single-stage semantic representation, especially for Polish paraphrases, plus new human-reviewed development
data and a newly sealed qualification packet—not relaxed thresholds or reuse of the observed packets.
