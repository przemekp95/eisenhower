import hashlib
from pathlib import Path

from scripts.benchmark_classifier import (
  evaluation_approval_issues,
  evaluation_sha256,
  evaluate_incumbent,
)


def test_evaluation_sha_and_approval_issues_bind_report_to_exact_bytes(tmp_path: Path):
  dataset = tmp_path / "evaluation.json"
  dataset.write_bytes(b'{"examples":[]}\n')
  digest = hashlib.sha256(dataset.read_bytes()).hexdigest()

  assert evaluation_sha256(dataset) == digest
  assert evaluation_approval_issues(digest, digest) == []
  assert evaluation_approval_issues(digest, None) == [
    {"code": "approved_evaluation_sha256_missing", "actual": digest}
  ]
  assert evaluation_approval_issues(digest, "a" * 64) == [
    {"code": "approved_evaluation_sha256_mismatch", "actual": digest, "required": "a" * 64}
  ]


def test_incumbent_comparison_reports_missing_artifact_instead_of_silently_skipping(tmp_path: Path):
  class MissingIncumbent:
    head_path = tmp_path / "missing-head.pt"
    meta_path = tmp_path / "missing-meta.json"
    index_path = tmp_path / "missing-index.json"

  report, metrics = evaluate_incumbent(
    MissingIncumbent(),
    records=[],
    evaluation_embeddings=[[1.0, 0.0]],
    evaluation_labels=[0],
    evaluation_languages=["en"],
  )

  assert metrics is None
  assert report == {"available": False, "reason": "incumbent_artifact_missing"}
