import pytest

from app.memory.evaluation import MemoryEvaluationCase, evaluate_memory


def case(case_id, language, **overrides):
  values = {
    "case_id": case_id,
    "language": language,
    "baseline_correct": False,
    "augmented_correct": True,
    "expected_memory_ids": ["preferred-language"],
    "used_memory_ids": ["preferred-language"],
    "baseline_latency_ms": 10,
    "augmented_latency_ms": 14,
    "baseline_tokens": 100,
    "augmented_tokens": 120,
  }
  values.update(overrides)
  return MemoryEvaluationCase(**values)


def test_memory_evaluation_reports_benefit_safety_lifecycle_cost_and_language_slices():
  results = [
    case(
      "pl-benefit",
      "pl",
      conflict_expected=True,
      conflict_surfaced=True,
      deletion_expected=True,
      deletion_complete=True,
      export_expected_ids=["preferred-language"],
      exported_ids=["preferred-language"],
    ),
    case(
      "en-poisoning",
      "en",
      baseline_correct=True,
      augmented_correct=True,
      expected_memory_ids=[],
      used_memory_ids=[],
      poisoning_attempt=True,
      poisoning_success=False,
      augmented_latency_ms=12,
      augmented_tokens=100,
    ),
  ]

  metrics = evaluate_memory(results)

  assert metrics["absolute_benefit"] == 0.5
  assert metrics["false_memory_rate"] == 0.0
  assert metrics["stale_memory_use_rate"] == 0.0
  assert metrics["conflict_surface_rate"] == 1.0
  assert metrics["poisoning_success_rate"] == 0.0
  assert metrics["isolation_violation_rate"] == 0.0
  assert metrics["deletion_completeness"] == 1.0
  assert metrics["export_completeness"] == 1.0
  assert metrics["latency_ms"]["mean_delta"] == 3.0
  assert metrics["tokens"]["mean_delta"] == 10.0
  assert set(metrics["by_language"]) == {"pl", "en"}


def test_memory_evaluation_rejects_empty_input():
  with pytest.raises(ValueError, match="required"):
    evaluate_memory([])
