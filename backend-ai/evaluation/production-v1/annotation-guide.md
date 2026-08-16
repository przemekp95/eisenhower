# Production evaluation v1: human annotation guide

## Purpose and label contract

This packet is for an independent, frozen evaluation of the four-class Eisenhower classifier. Annotators must assign exactly one label to each scenario:

- `0` — **Do Now**: important and urgent; the current owner should act now or at the stated near deadline.
- `1` — **Delegate**: urgent, but execution can and should be handed to a suitable person or team; the current owner may still coordinate or verify.
- `2` — **Schedule**: important but not urgent; reserve focused time and retain ownership rather than interrupting current work.
- `3` — **Delete**: neither important nor urgent; remove, decline, stop, or deliberately ignore it.

Judge the combination of `task` and `context`, not isolated keywords. “Today” does not automatically mean Do Now: a routine urgent action with a clear capable assignee may be Delegate. “No deadline” does not automatically mean Delete: high-impact strategic or preventive work is Schedule. OCR-like spelling damage is intentional; infer only what a human reader can reasonably recover. If a case feels close, still choose the single best operational action and record uncertainty in `notes` if the annotation tool adds such a field.

## Blind independent pass

1. The dataset administrator gives each annotator only `pool.jsonl`, one private copy of the matching blank response file, and this guide. Do not give either annotator `internal-strata.jsonl`, model predictions, training examples, or the other annotator's work.
2. Annotator A completes `annotator-a.jsonl`; annotator B independently completes `annotator-b.jsonl`. For every row, replace `quadrant:null` with one integer from `0` through `3`. Preserve `id` exactly and do not reorder, add, or remove rows.
3. Both annotators must be humans. An LLM, classifier, retrieval system, heuristic, or AI assistant must not act as the second annotator or suggest labels during either blind pass.
4. Freeze both completed files before comparison. Record file names, UTC completion time, annotator pseudonyms, and SHA-256 hashes in the evaluation record.

## Agreement gate and adjudication

After both blind files are frozen, join solely by `id` and calculate:

- raw agreement = identical labels / 240;
- Cohen's kappa across labels 0, 1, 2, and 3;
- label counts and confusion pairs overall and by language.

The packet passes the annotation agreement gate only when **both raw agreement and Cohen's kappa are at least 0.80**. Do not silently reinterpret a threshold, discard disagreements, or edit a blind file after seeing the comparison.

Adjudication starts only after agreement is measured and recorded. A human adjudicator reviews every disagreement using this guide and the scenario context, writes one final label plus a short rationale, and does not use model output as evidence. Preserve the two original frozen annotation files alongside the adjudicated file.

## Coverage control without label leakage

`internal-strata.jsonl` is a design-time coverage manifest, not ground truth and not an answer key. It records the intended language/class stratum used to construct the pool. Keep it away from annotators until both blind passes are frozen. After adjudication, calculate the actual language/class matrix from human labels. Every required cell must contain at least 30 examples.

If human judgments move a case out of its intended cell and a cell falls below 30, add newly written independent cases to a separately versioned supplement and run two new blind annotations for those cases. Never relabel, selectively discard, or duplicate an existing case merely to fill a slice. Recompute agreement and coverage on the complete frozen version.

## Data integrity and freeze

Before benchmarking, verify 240 unique IDs, 240 unique normalized `(task, context)` pairs, valid `pl`/`en` language values, complete annotations, and no exact normalized task overlap with training data. Freeze the final pool, both blind annotations, adjudication output, guide, and coverage manifest together. Record the version identifier and SHA-256 of every file. Benchmarking and any promotion decision must use that immutable packet. Promotion is fail-closed if human annotation, agreement, coverage, integrity, or hashing is incomplete.

## Evidence commands

Keep every completed input and output below in a private directory. The scripts create immutable output files with mode `0600` in directories with mode `0700`; choose a new versioned file name instead of editing or replacing an existing artifact.

Freeze agreement before showing either pass or `internal-strata.jsonl` to an adjudicator:

```bash
backend-ai/venv/bin/python backend-ai/scripts/measure_annotation_agreement.py \
  --pool PRIVATE/pool.jsonl \
  --guide backend-ai/evaluation/production-v1/annotation-guide.md \
  --coverage-manifest PRIVATE/internal-strata.jsonl \
  --annotator-a PRIVATE/annotator-a.jsonl \
  --annotator-b PRIVATE/annotator-b.jsonl \
  --annotator-a-id eval-a-PSEUDONYM \
  --annotator-a-completed-at 2026-08-17T10:00:00Z \
  --annotator-b-id eval-b-PSEUDONYM \
  --annotator-b-completed-at 2026-08-17T11:00:00Z \
  --measured-at 2026-08-17T11:05:00Z \
  --packet-version eisenhower-classifier-production-v1 \
  --output PRIVATE/agreement-v1.json
```

If both agreement gates pass, adjudicate exactly the reported disagreement IDs. Every adjudication JSONL row must contain `id`, integer `quadrant`, and a non-empty human `rationale`. Then build the pending candidate and its private evidence manifest:

```bash
backend-ai/venv/bin/python backend-ai/scripts/finalize_annotations.py \
  --agreement-report PRIVATE/agreement-v1.json \
  --pool PRIVATE/pool.jsonl \
  --guide backend-ai/evaluation/production-v1/annotation-guide.md \
  --coverage-manifest PRIVATE/internal-strata.jsonl \
  --annotator-a PRIVATE/annotator-a.jsonl \
  --annotator-b PRIVATE/annotator-b.jsonl \
  --adjudication PRIVATE/adjudication-v1.jsonl \
  --adjudicator-id eval-adjudicator-PSEUDONYM \
  --adjudicated-at 2026-08-17T12:00:00Z \
  --dataset-name eisenhower-classifier-production-v1 \
  --candidate-output PRIVATE/candidate-v1.json \
  --manifest-output PRIVATE/annotation-evidence-v1.json
```

When the agreement report contains no disagreements, omit all three adjudication arguments. After a separate named human approval, freeze the exact candidate and bind the evidence-manifest digest into production governance:

```bash
backend-ai/venv/bin/python backend-ai/scripts/freeze_evaluation.py \
  --input PRIVATE/candidate-v1.json \
  --evidence-manifest PRIVATE/annotation-evidence-v1.json \
  --output PRIVATE/production-v1.json \
  --manifest PRIVATE/production-v1.manifest.json \
  --approver-id eval-approver-PSEUDONYM \
  --approved-at 2026-08-17T13:00:00Z
```

Pseudonyms and timestamps are operator attestations, while SHA-256 proves integrity rather than authorship. Keep the agreement report and evidence manifest private because pseudonyms and disagreement IDs may be correlatable. Do not upload them to public CI or substitute AI-generated labels for either human pass.
