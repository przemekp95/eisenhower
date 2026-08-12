from __future__ import annotations

import math

import pytest

from app.artifacts.registry import ImmutableArtifactRegistry
from app.ops.monitoring import (
  MonitoringContractError,
  build_quality_drift_report,
  register_quality_report,
)


def _snapshots() -> dict:
  return {
    phase: {
      "baseline": {"quality": 0.90, "error_rate": 0.01},
      "current": {"quality": 0.89, "error_rate": 0.015},
      "slices": {"pl": {"quality": 0.88}, "en": {"quality": 0.90}},
      "sample_count": 100,
    }
    for phase in ("classifier", "retrieval", "generation", "response", "mag")
  }


def test_quality_drift_report_is_checksummed_green_and_phase_complete():
  report = build_quality_drift_report(
    baseline_candidate_id="baseline-v1",
    current_candidate_id="candidate-v2",
    snapshots=_snapshots(),
    maximum_absolute_drift=0.05,
  )

  assert report["status"] == "green"
  assert set(report["phases"]) == {"classifier", "retrieval", "generation", "response", "mag"}
  assert len(report["report_checksum"]) == 64


def test_quality_drift_report_blocks_on_phase_or_slice_drift_and_missing_phase():
  snapshots = _snapshots()
  snapshots["retrieval"]["current"]["quality"] = 0.70
  snapshots["generation"]["slices"]["pl"]["quality"] = 0.60
  del snapshots["mag"]

  report = build_quality_drift_report(
    baseline_candidate_id="baseline-v1",
    current_candidate_id="candidate-v2",
    snapshots=snapshots,
    maximum_absolute_drift=0.05,
  )

  assert report["status"] == "blocked"
  assert {reason["code"] for reason in report["reasons"]} == {
    "metric_drift",
    "slice_drift",
    "phase_missing",
  }


@pytest.mark.parametrize(
  "sensitive_key",
  ["prompt", "prompt_tokens", "user_id", "tenant_id", "email", "private_identifier", "content"],
)
def test_quality_drift_report_rejects_sensitive_fields(sensitive_key):
  snapshots = _snapshots()
  snapshots["classifier"][sensitive_key] = "secret"

  with pytest.raises(MonitoringContractError, match="sensitive field"):
    build_quality_drift_report(
      baseline_candidate_id="baseline-v1",
      current_candidate_id="candidate-v2",
      snapshots=snapshots,
      maximum_absolute_drift=0.05,
    )


@pytest.mark.parametrize("invalid_value", [math.nan, math.inf, -math.inf])
def test_quality_drift_report_rejects_non_finite_metrics(invalid_value):
  snapshots = _snapshots()
  snapshots["retrieval"]["current"]["quality"] = invalid_value

  with pytest.raises(MonitoringContractError, match="finite numeric"):
    build_quality_drift_report(
      baseline_candidate_id="baseline-v1",
      current_candidate_id="candidate-v2",
      snapshots=snapshots,
      maximum_absolute_drift=0.05,
    )


def test_quality_report_is_registered_with_monitoring_lineage(tmp_path):
  report = build_quality_drift_report(
    baseline_candidate_id="baseline-v1",
    current_candidate_id="candidate-v2",
    snapshots=_snapshots(),
    maximum_absolute_drift=0.05,
  )
  manifest = register_quality_report(
    registry=ImmutableArtifactRegistry(tmp_path / "registry"),
    candidate_id="monitoring-candidate-v2",
    git_sha="d" * 40,
    git_dirty=False,
    report=report,
  )

  assert manifest.workflow == "monitoring"
  assert manifest.reports.items[0].name == "quality-drift-report"
