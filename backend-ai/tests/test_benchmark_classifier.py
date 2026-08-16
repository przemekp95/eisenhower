import hashlib
from pathlib import Path

from scripts.benchmark_classifier import (
  evaluation_approval_issues,
  evaluation_sha256,
  evaluate_incumbent,
  merge_production_reasons,
)


def test_evaluation_sha_and_approval_issues_bind_report_to_exact_bytes(tmp_path: Path):
  dataset = tmp_path / "evaluation.json"
  dataset.write_bytes(b'{"examples":[]}\n')
  digest = hashlib.sha256(dataset.read_bytes()).hexdigest()

  assert evaluation_sha256(dataset) == digest
  assert not evaluation_approval_issues(digest, digest)
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


def test_production_reasons_include_every_failed_model_quality_gate():
  governance = [{"code": "evaluation_not_approved"}]
  gate = {
    "passed": False,
    "reasons": [
      {"code": "macro_f1_too_low", "actual": 0.79, "minimum": 0.80},
      {"code": "calibration_ece_too_high", "actual": 0.11, "maximum": 0.10},
    ],
  }

  assert merge_production_reasons(governance, gate) == [
    {"code": "evaluation_not_approved"},
    {"code": "macro_f1_too_low", "actual": 0.79, "minimum": 0.80},
    {"code": "calibration_ece_too_high", "actual": 0.11, "maximum": 0.10},
  ]
