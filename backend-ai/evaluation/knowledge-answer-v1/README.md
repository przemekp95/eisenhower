# Knowledge-answer technical holdout v1

This directory freezes the first deterministic technical holdout for the separate
`knowledge-answer` response contract.

- `holdout.jsonl` contains 24 synthetic fixed-context cases: 12 Polish and 12 English,
  balanced between answerable and required-abstention cases. Six cases contain explicit
  prompt-injection instructions.
- `policy.json` was frozen before the first live run. It requires safe abstention recall,
  citations, schema and injection resistance to pass without using another model as judge.
- `report-rocm-local-v1.json` is the aggregate-only first-run result from the pinned Qwen
  model on the physical local AMD runtime. It intentionally contains no generated answer
  text and binds the dataset, policy, prompt, model, schema and evaluated source commit.

The holdout proves a bounded fixed-context generation gate. It does not prove retrieval,
HTTP/OIDC behavior, production traffic, percentage-based canary routing or independent
human review. The frozen packet must not be edited or used for prompt tuning after opening.
