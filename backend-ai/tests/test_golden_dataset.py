import json
from pathlib import Path

import pytest

from app.rag.golden import load_golden_dataset


def test_repository_golden_dataset_is_versioned_unique_and_covers_release_risks():
  cases = load_golden_dataset(Path(__file__).parents[1] / "evaluation/golden-v1.jsonl")

  assert {case.expected_quadrant for case in cases if case.expected_quadrant is not None} == {0, 1, 2, 3}
  assert len({case.case_id for case in cases}) == len(cases)
  assert {case.dataset_version for case in cases} == {"golden-synthetic-v1"}
  tags = {tag for case in cases for tag in case.tags}
  assert {"tenant-isolation", "prompt-injection", "no-answer", "deleted"} <= tags
  assert {
    "task-injection", "misleading-similar-example", "conflicting-signals",
    "explicit-deadline-low-impact", "high-impact-no-deadline", "no-context",
    "irrelevant-context", "contradictory-context", "duplicate-context",
    "citation-id-in-content", "unicode", "emoji", "short-task", "long-task",
    "token-boundary", "schema-violation", "truncated-output", "vllm-fallback",
  } <= tags
  assert all(case.corpus_version and case.index_version for case in cases)
  assert all(case.difficulty in {"basic", "edge", "adversarial"} for case in cases)
  for case in cases:
    if case.expected_quadrant is not None:
      assert case.expected_urgent is not None
      assert case.expected_important is not None


def test_golden_loader_rejects_mixed_versions(tmp_path):
  path = tmp_path / "golden.jsonl"
  base = {
    "case_id": "case-a", "tenant_id": "synthetic-a", "user_id": "u1",
    "task": "Task", "expected_quadrant": 0, "answerability": "answerable",
    "relevant_document_ids": ["doc-1"], "allowed_citation_ids": ["chunk-1"],
    "tags": ["test"],
  }
  path.write_text(
    "\n".join(json.dumps({**base, "dataset_version": version, "case_id": f"case-{version}"})
              for version in ["v1", "v2"]),
    encoding="utf-8",
  )

  with pytest.raises(ValueError, match="one immutable dataset version"):
    load_golden_dataset(path)
