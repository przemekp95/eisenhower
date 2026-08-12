# CI impact classifier

## Current status

This package is a separate multilabel CI change-impact system. It does not import, retrain, wrap or
change the four-class Eisenhower task classifier. No GitHub Actions job is skipped and
`.github/workflows/ci.yml` is unchanged.

The latest checked-in history snapshot contains 19 merged `dev` PRs from PR 141–160, 868 file
observations, 162 observed job results and 209 unknown labels for the eleven current CI jobs. The
prior 141–157 snapshot remains immutable; older records retain unknown labels for jobs introduced
later. There is no trained or promoted CI model and no quality claim. Running candidate training
against the latest snapshot fails closed before writing a model.

## Contracts and isolation

The versioned contracts live under `backend-ai/ci-impact/`:

- `ci-impact-history-record-v1` and `ci-impact-dataset-v1` for factual PR/file/job observations and
  manually governed labels;
- `ci-impact-features-v1` for paths, change kind, old/new rename paths, deletion, binary state,
  manifest/lockfile/workflow flags, diffstat and reverse local dependencies;
- `ci-impact-model-v1` for independent logistic job heads returning job probabilities. Optional
  diff embeddings are bounded `aux.*` features and cannot override deterministic abstention rules;
- `ci-impact-shadow-plan-v1` for probabilities, `unknown/abstain`, deterministic jobs, classifier
  jobs and the effective additive plan;
- `ci-impact-candidate-v1` and `ci-impact-promotion-evidence-v1` for a private, immutable namespace
  binding Git state, dataset, feature implementation/schema, canonical job config, workflow,
  promotion policy, runtime, model, evaluation and externally verified approval checksums.

Cache and registry paths are independent (`backend-ai/ci-impact/cache/` and `registry/`) and ignored
by Git. Content-addressed blobs use exclusive writes and private filesystem modes. Candidate
registration has no current/champion pointer and no workflow/deployment operation.

`branch-policy` remains a separate deterministic required context. `resolve-run-mode` remains
workflow orchestration. `security-lint` is included in the CI plan but is deterministic and cannot
be removed by a learned head. The ten remaining test jobs are classifier candidates, including
`test-n8n-workflows`. The config separates every job in `ci.yml` from orchestration and verifies the
required-context set mirrored by the sync bridge; any drift is a reason to abstain.

## Data acquisition and labels

Refresh a bounded observation snapshot with read-only GitHub access:

```bash
cd backend-ai
PYTHONPATH=. python scripts/collect_ci_impact_history.py \
  --repo przemekp95/eisenhower \
  --base dev \
  --minimum-pr 141 \
  --maximum-pr 160 \
  --jobs-config ci-impact/config/jobs-v1.json \
  --output ci-impact/datasets/github-pr-141-160-authenticated-v1.jsonl \
  --receipt ci-impact/datasets/github-pr-141-160-authenticated-v1.receipt.json
```

The collector binds the PR base/head, merged timestamp, old/new paths, change/diffstat, observed
check-run results and the workflow blob at that head. Check evidence is accepted only from the
GitHub Actions app through a check-suite whose `head_sha` matches the exact PR head; repository and
base identities are also exact. The PR window, requests, cumulative response bytes, total files and
total check results are bounded. It deliberately initializes every label as unknown. The annotation rules are in
`backend-ai/ci-impact/datasets/ANNOTATION_GUIDE.md`. History collection should run only in a trusted,
read-only context with `contents:read`, `actions:read` and `pull-requests:read`; it must not execute
PR code through `pull_request_target`.

## Features and model

The extractor parses absolute and relative Python imports and JS/TS relative imports into a bounded
reverse graph. Training unions graphs reconstructed by `git archive` from each historical base and
head SHA, so deleted modules, the old side of renames and temporal epochs retain their dependency
edges without applying a future graph. Source/archive file, total-byte, process-output and timeout
limits are enforced before materialization. Syntax errors, dynamic/unresolved imports and limit
hits are recorded and force abstention; an embedding never fills those gaps.

`MultilabelLogisticModel` trains one binary head per classifier-controlled job and ignores unknown
labels. Training requires both reviewed `required` and `safe_to_skip` evidence for every head in
both the training and temporal holdout partitions. The current dataset fails that gate, as intended.

The evaluator reports per-job required-job recall, unsafe-skip rate, precision, Brier score,
expected calibration error and support, plus abstention/selective coverage, five-training-seed
stability and epoch coverage. Abstained required cases count as counterfactual misses rather than
being credited with the effective full-CI fallback. The model and conservative rule baseline are
evaluated on the same temporal holdout. Promotion evidence requires dependency, workflow, lockfile, rename, binary and
unknown-path epochs. Default gates require recall `1.0`, unsafe-skip rate `0.0`, adequate per-job
support, bounded calibration/abstention and stability; missing denominators or baseline jobs block.
The checked-in promotion policy is explicitly `owner_approved=false`, so even complete future labels
and green metrics cannot become promotion-eligible until a separate human threshold decision is
checksum-bound. The trainer cannot create that trusted approval receipt itself. The current
implementation intentionally has no trusted approval verifier, so no candidate can be eligible or
loaded even if a caller supplies schema-valid reviewer names, evidence text or a receipt checksum.
Those fields and recomputable SHA-256/O_EXCL storage provide integrity/conflict detection, not
writer authentication. A future promotion task must add an approved reviewer allowlist and an
authenticated dual-review/adjudication attestation bound to the exact dataset checksum.

Candidate-only training command (currently expected to exit `2` for missing manual labels):

```bash
cd backend-ai
PYTHONPATH=. python scripts/train_ci_impact_candidate.py \
  --dataset ci-impact/datasets/github-pr-141-160-authenticated-v1.jsonl \
  --jobs-config ci-impact/config/jobs-v1.json \
  --promotion-policy ci-impact/config/promotion-policy-v1.json \
  --target-adapter ci-impact/config/deterministic-target-jobs-v1.json \
  --registry ci-impact/registry \
  --model-cache ci-impact/cache/model-v1.json \
  --output ci-impact/cache/candidate-v1.json \
  --candidate-id ci-impact-reviewed-v1
```

The command derives the exact SHA and dirty state from the repository instead of accepting
caller-asserted lineage. A dirty tree is always a blocker. A passing quality artifact still does not
alter a pointer, workflow or deployment, and promotion remains blocked without a separately
authenticated owner approval receipt.

## Shadow evaluation and future integration

Run a counterfactual plan without a model to exercise the safe fallback:

```bash
cd backend-ai
HEAD_SHA="$(git -C .. rev-parse HEAD)"
MERGE_BASE="$(git -C .. merge-base origin/dev "$HEAD_SHA")"
node ../.github/scripts/ci-impact-plan.mjs \
  --base origin/dev --head "$HEAD_SHA" --event pull_request \
  --ref shadow-local --base-ref dev --output /tmp/eisenhower-deterministic-plan.json
PYTHONPATH=. python scripts/run_ci_impact_shadow.py \
  --base-sha "$MERGE_BASE" \
  --head-sha "$HEAD_SHA" \
  --jobs-config ci-impact/config/jobs-v1.json \
  --promotion-policy ci-impact/config/promotion-policy-v1.json \
  --target-adapter ci-impact/config/deterministic-target-jobs-v1.json \
  --deterministic-plan /tmp/eisenhower-deterministic-plan.json \
  --event-name pull_request --ref-name shadow-local --base-ref-name dev \
  --repo-root .. \
  --output /tmp/eisenhower-ci-impact-shadow.json
```

This currently reports `model_unavailable`, `abstain=true`, `full_ci=true`, and all eleven CI jobs.
Because this is a local invocation, its explicit event/ref arguments are untrusted and it also reports
`github_actions_context_untrusted`; local evaluation can never become selective, even if a candidate
is later available. In GitHub Actions, a selective result requires `GITHUB_ACTIONS=true` and the
immutable `GITHUB_EVENT_NAME`, `GITHUB_REF_NAME` and `GITHUB_BASE_REF` context. Optional CLI values
must match that context exactly and cannot override it, so a schedule or protected master/release run
cannot be presented as a feature PR.
The command resolves the two revisions, verifies ancestry and derives the changed paths, statuses,
renames, binary state and diffstat directly from Git. With a checksum-bound candidate, add `--registry`, `--candidate-id` and optionally
`--expected-model-checksum`. The registry loader re-verifies the candidate, model and evaluation
blobs plus the semantic promotion evidence, authenticated approval receipt, dataset, feature
implementation/schema, job config, workflow, policy and runtime lineage. The
command publishes validated JSON only; it cannot edit Actions or emit skip outputs.
The deterministic plan is mandatory for any selective result and is re-bound to the resolved full
base/head SHAs, trusted event/ref context, exact canonical name-status diff and recomputed input
digest. The CLI independently reruns the canonical JavaScript resolver in a bounded argv-only
process and requires exact equality of `fullCi`, targets, reasons and all input evidence. Missing,
stale, foreign, narrowed or mismatched plans force full CI. If revision/diff evaluation fails after the canonical job config is loaded, the command still exits
successfully with a machine-readable `shadow_evaluation_error` plan containing every job; an
unreadable job config exits nonzero and therefore authorizes no skip decision.
The resolver subprocess receives a minimal locale/PATH environment and never inherits Actions
command-file variables such as `GITHUB_OUTPUT` or `GITHUB_STEP_SUMMARY`, so recomputation remains
read-only and cannot contaminate downstream step outputs.

Shadow mode always leaves full CI authoritative. A later, separately reviewed workflow task may
pass the existing `ci-impact-plan/v1` JSON with `--deterministic-plan`. The separate
`ci-impact-deterministic-adapter-v1` maps its twelve logical targets to canonical job names. Unknown
targets, adapter drift or deterministic `fullCi=true` all force full CI. A later, separately
reviewed workflow task may consume only this additive decision:

```text
effective_jobs = deterministic_jobs UNION classifier_jobs
```

Every exception, timeout, invalid schema, checksum mismatch, job-universe/workflow drift, low
confidence, out-of-domain path, unknown job, manifest/lockfile/workflow change or parser limit means
abstain/full CI. Integration, threshold approval, workflow changes and promotion remain outside this
PR.

Before any future approval verifier exists, collection and lineage must also be strengthened. The
current evidence does not prove an immutable repository ID plus the exact `ci.yml` workflow run and
event, while initial queries and `gh --paginate --slurp` do not enforce an actual cumulative page
budget. Dataset and registry bytes are read before semantic validation, and the collector receipt is
not candidate lineage (only the dataset checksum is). Eligibility therefore requires a separately
authenticated receipt covering immutable repository identity, exact workflow run/event, collector
identity and dataset checksum, bound to candidate lineage and verified before bounded payload use.
It must accompany an approved-reviewer allowlist and authenticated dual-review/adjudication
attestation. Until then no candidate is eligible; recomputable hashes, `O_EXCL`, schema-valid
reviewer IDs and receipt fields are integrity evidence, not writer authentication.

## Verification and methodology boundaries

New-code red evidence was captured first as collection failure on missing `app.ci_impact`; after the
implementation the focused suite passed. A second red cycle failed on missing promotion/training
contracts before those modules were added. This is red-green evidence for this new slice only; it
does not prove historical TDD adoption. The epoch tests are ordinary executable tests, not BDD or
living Gherkin scenarios.

CSRF is not applicable to the offline CLI. HTTP is limited to read-only GitHub API collection and
needs TLS, bounded pagination/timeouts and exact repository identity. There is no Messenger, queue,
job consumer or webhook runtime in this package; JSON outputs and private artifacts are the message
boundaries. The package uses isolated contracts and adapters, but makes no claim that the monorepo is
fully DDD, CQRS or hexagonal.

See `docs/ci-impact-threat-model.md` for the repository-grounded risk review.

Published JSON Schemas are generated from the strict runtime models with
`PYTHONPATH=. python scripts/generate_ci_impact_schemas.py`; the focused suite verifies that checked-in
schemas remain byte-semantic equivalents of those models.
