import copy

import pytest

from app.rag.task049_evaluation import (
  aggregate_repeated_reports,
  select_candidate,
  validation_gate,
)


POLICY = {
  "global": {"recall_at_k_min": 0.9, "mrr_at_k_min": 0.8, "no_answer_accuracy_min": 1.0},
  "languages": {"recall_at_k_min": 0.85, "mrr_at_k_min": 0.75},
  "safety": {
    "forbidden_hit_rate_max": 0.0,
    "stale_hit_rate_max": 0.0,
    "isolation_violation_rate_max": 0.0,
    "document_duplicate_rate_max": 0.0,
  },
  "latency": {"warm_p95_ms_max": 100.0, "incumbent_ratio_max": 0.6},
  "non_inferiority": {"global_min_delta": -0.02, "language_min_delta": -0.03},
}


def report(*, recall=0.92, mrr=0.84, no_answer=1.0, p95=60.0):
  return {
    "metrics": {
      "recall_at_k": recall,
      "mrr": mrr,
      "no_answer_accuracy": no_answer,
      "forbidden_hit_rate": 0.0,
      "stale_hit_rate": 0.0,
      "isolation_violation_rate": 0.0,
      "document_duplicate_rate": 0.0,
      "latency_ms": {"p95": p95},
      "by_language": {
        "pl": {"recall_at_k": recall, "mrr": mrr},
        "en": {"recall_at_k": recall, "mrr": mrr},
      },
    }
  }


def test_calibration_selection_requires_quality_no_answer_and_zero_tolerance_safety():
  unsafe = report(recall=0.99, mrr=0.99)
  unsafe["metrics"]["forbidden_hit_rate"] = 0.01
  misses_no_answer = report(recall=0.98, mrr=0.95, no_answer=0.99)
  selected = report(recall=0.93, mrr=0.86)

  assert select_candidate({
    "unsafe": unsafe,
    "misses-no-answer": misses_no_answer,
    "selected": selected,
  }, POLICY) == "selected"


def test_calibration_selection_fails_closed_when_no_candidate_passes():
  with pytest.raises(ValueError, match="no candidate"):
    select_candidate({"bad": report(no_answer=0.75)}, POLICY)


def test_validation_gate_checks_absolute_non_inferiority_and_latency_ratio():
  challenger = report(recall=0.92, mrr=0.84, p95=60.0)
  incumbent = report(recall=0.93, mrr=0.85, p95=110.0)

  gate = validation_gate(challenger, incumbent, POLICY)

  assert gate["passed"] is True
  assert all(gate["checks"].values())


@pytest.mark.parametrize(
  ("path", "value"),
  [
    (("metrics", "recall_at_k"), 0.89),
    (("metrics", "mrr"), 0.79),
    (("metrics", "no_answer_accuracy"), 0.99),
    (("metrics", "by_language", "pl", "mrr"), 0.74),
    (("metrics", "forbidden_hit_rate"), 0.01),
    (("metrics", "document_duplicate_rate"), 0.01),
    (("metrics", "latency_ms", "p95"), 101.0),
  ],
)
def test_validation_gate_fails_each_absolute_boundary(path, value):
  challenger = report()
  target = challenger
  for key in path[:-1]:
    target = target[key]
  target[path[-1]] = value

  assert validation_gate(challenger, report(p95=200.0), POLICY)["passed"] is False


def test_validation_gate_fails_language_non_inferiority_and_latency_ratio():
  challenger = report(p95=61.0)
  incumbent = report(recall=0.96, mrr=0.90, p95=100.0)
  challenger["metrics"]["by_language"]["pl"]["mrr"] = 0.86

  gate = validation_gate(challenger, incumbent, POLICY)

  assert gate["passed"] is False
  assert gate["checks"]["language_pl.mrr_non_inferiority"] is False
  assert gate["checks"]["latency.incumbent_ratio_max"] is False


def test_validation_gate_fails_closed_on_missing_metrics():
  challenger = copy.deepcopy(report())
  del challenger["metrics"]["by_language"]["en"]

  with pytest.raises(ValueError, match="invalid TASK-049 metrics"):
    validation_gate(challenger, report(), POLICY)


def test_validation_aggregation_requires_five_identical_quality_repetitions():
  repetitions = []
  for index in range(5):
    current = report(p95=50.0 + index)
    current["dataset_version"] = "task049-synthetic-validation-v1"
    current["cases"] = [{
      "case_id": "case-1",
      "retrieved_document_ids": ["doc-1"],
      "latency_ms": 45.0 + index,
    }]
    repetitions.append(current)

  aggregated = aggregate_repeated_reports(repetitions)

  assert aggregated["repetition_count"] == 5
  assert aggregated["metrics"]["latency_ms"]["p95"] == 49.0
  assert aggregated["metrics"]["recall_at_k"] == 0.92


def test_validation_aggregation_fails_closed_on_quality_drift():
  repetitions = []
  for _ in range(5):
    current = report()
    current["dataset_version"] = "task049-synthetic-validation-v1"
    current["cases"] = [{"case_id": "case-1", "retrieved_document_ids": ["doc-1"]}]
    repetitions.append(current)
  repetitions[-1]["cases"][0]["retrieved_document_ids"] = ["doc-2"]

  with pytest.raises(ValueError, match="quality drift"):
    aggregate_repeated_reports(repetitions)
