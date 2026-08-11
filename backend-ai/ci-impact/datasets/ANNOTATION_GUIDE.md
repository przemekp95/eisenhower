# CI impact history annotation guide

The GitHub history files in this directory contain observations, not inferred counterfactual
labels. A successful job means only that the job passed when it ran. It never means that the job
was safe to skip.

For every PR and every classifier-controlled job, a human reviewer must choose exactly one value:

- `required`: repository evidence shows that the job protects a changed path, a transitive local
  dependency, a build/deployment consumer, a manifest or another relevant contract;
- `safe_to_skip`: a conservative manual review establishes that neither the changed paths nor their
  old/new rename paths, reverse dependencies, build contexts, manifests or job scripts can affect
  the job;
- `unknown`: evidence is incomplete, ambiguous, flaky, dynamically resolved or outside the known
  graph. This is the default and causes abstention/full CI.

`required` and `safe_to_skip` require `reviewer_id`, a concise evidence reference and provenance
`manual_review` or `manual_adjudication`. Canceled, skipped, neutral, missing, rerun and successful
observations stay `unknown` unless the counterfactual question is reviewed independently. Before a
promotion-quality freeze, conflicting reviews require human adjudication and the dataset checksum
must be regenerated. Do not add author names, tokens, raw diff content or private identifiers.

The current `github-pr-141-157-v1.jsonl` snapshot intentionally has zero decided labels and 160
`manual_review_required` labels. It is acquisition evidence only.
