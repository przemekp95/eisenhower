# CI impact classifier

## Current status

This package is a separate multilabel CI change-impact system. It does not import, retrain, wrap or
change the four-class Eisenhower task classifier. No GitHub Actions job is skipped and
`.github/workflows/ci.yml` is unchanged.

The checked-in history snapshot contains 16 merged `dev` PRs from PR 141–157, 832 file observations,
130 observed job results and 160 unknown labels for the ten current CI jobs. Older records retain
unknown labels for jobs introduced later. There is no trained or promoted CI model and no quality
claim. Running candidate training against this snapshot fails closed before writing a model.

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
  binding Git state, dataset, feature schema, canonical job config, workflow, runtime, model and
  evaluation checksums.

Cache and registry paths are independent (`backend-ai/ci-impact/cache/` and `registry/`) and ignored
by Git. Content-addressed blobs use exclusive writes and private filesystem modes. Candidate
registration has no current/champion pointer and no workflow/deployment operation.

`branch-policy` remains a separate deterministic required context. `resolve-run-mode` remains
workflow orchestration. `security-lint` is included in the CI plan but is deterministic and cannot
be removed by a learned head. The nine remaining test jobs are classifier candidates. The config
separates every job in `ci.yml` from the smaller required-context set mirrored by the sync bridge;
any drift in either contract is a reason to abstain.

## Data acquisition and labels

Refresh a bounded observation snapshot with read-only GitHub access:

```bash
cd backend-ai
PYTHONPATH=. python scripts/collect_ci_impact_history.py \
  --repo przemekp95/eisenhower \
  --base dev \
  --minimum-pr 141 \
  --maximum-pr 157 \
  --jobs-config ci-impact/config/jobs-v1.json \
  --output ci-impact/datasets/github-pr-141-157-v1.jsonl \
  --receipt ci-impact/datasets/github-pr-141-157-v1.receipt.json
```

The collector binds the PR base/head, merged timestamp, old/new paths, change/diffstat, observed
check-run results and the workflow blob at that head. It deliberately initializes every label as
unknown. The annotation rules are in
`backend-ai/ci-impact/datasets/ANNOTATION_GUIDE.md`. History collection should run only in a trusted,
read-only context with `contents:read`, `actions:read` and `pull-requests:read`; it must not execute
PR code through `pull_request_target`.

## Features and model

The extractor parses Python local imports and JS/TS relative imports into a bounded reverse graph.
Training reconstructs this graph from each historical head SHA using `git archive`, so temporal
holdout does not silently apply a future dependency graph to old changes. Rename/copy uses both
paths; delete follows reverse dependencies; binary, manifest, lockfile, workflow, parser-limit and
unknown-path cases remain explicit. Dynamic/unresolved imports are recorded, never filled in by an
embedding.

`MultilabelLogisticModel` trains one binary head per classifier-controlled job and ignores unknown
labels. Training requires both reviewed `required` and `safe_to_skip` evidence for every head in
both the training and temporal holdout partitions. The current dataset fails that gate, as intended.

The evaluator reports per-job required-job recall, unsafe-skip rate, precision, Brier score,
expected calibration error and support, plus abstention/selective coverage, repeated-input
stability and epoch coverage. The model and conservative rule baseline are evaluated on the same
temporal holdout. Promotion evidence requires dependency, workflow, lockfile, rename, binary and
unknown-path epochs. Default gates require recall `1.0`, unsafe-skip rate `0.0`, adequate per-job
support, bounded calibration/abstention and stability; missing denominators or baseline jobs block.
The checked-in promotion policy is explicitly `owner_approved=false`, so even complete future labels
and green metrics cannot become promotion-eligible until a separate human threshold decision is
checksum-bound.

Candidate-only training command (currently expected to exit `2` for missing manual labels):

```bash
cd backend-ai
PYTHONPATH=. python scripts/train_ci_impact_candidate.py \
  --dataset ci-impact/datasets/github-pr-141-157-v1.jsonl \
  --jobs-config ci-impact/config/jobs-v1.json \
  --promotion-policy ci-impact/config/promotion-policy-v1.json \
  --registry ci-impact/registry \
  --model-cache ci-impact/cache/model-v1.json \
  --output ci-impact/cache/candidate-v1.json \
  --candidate-id ci-impact-reviewed-v1 \
  --git-sha "$(git rev-parse HEAD)" \
  --git-dirty
```

Omit `--git-dirty` only for a verified clean revision. A passing evidence artifact still does not
alter a pointer, workflow or deployment.

## Shadow evaluation and future integration

Run a counterfactual plan without a model to exercise the safe fallback:

```bash
cd backend-ai
PYTHONPATH=. python scripts/run_ci_impact_shadow.py \
  --changes ci-impact/examples/changes-v1.json \
  --jobs-config ci-impact/config/jobs-v1.json \
  --repo-root .. \
  --output /tmp/eisenhower-ci-impact-shadow.json
```

This currently reports `model_unavailable`, `abstain=true`, `full_ci=true`, and all ten CI jobs.
With a checksum-bound candidate, add `--registry`, `--candidate-id` and optionally
`--expected-model-checksum`. The registry loader re-verifies the candidate, model and evaluation
blobs plus Git cleanliness, dataset, feature schema, job config, workflow and runtime lineage. The
command publishes validated JSON only; it cannot edit Actions or emit skip outputs.

Shadow mode always leaves full CI authoritative. A later, separately reviewed workflow task may
consume only this additive decision:

```text
effective_jobs = deterministic_jobs UNION classifier_jobs
```

Every exception, timeout, invalid schema, checksum mismatch, job-universe/workflow drift, low
confidence, out-of-domain path, unknown job, manifest/lockfile/workflow change or parser limit means
abstain/full CI. Integration, threshold approval, workflow changes and promotion remain outside this
PR.

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
