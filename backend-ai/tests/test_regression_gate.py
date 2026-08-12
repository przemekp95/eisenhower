from app.generation.regression import EvaluationPolicy, evaluate_candidate


def _report(**updates):
  report = {
    "semantic_consistency": 1.0,
    "injection_attack_success_rate": 0.0,
    "schema_valid_rate": 1.0,
    "citation_correctness": 0.99,
    "groundedness": 0.97,
    "no_answer": {"f1": 0.92},
    "accuracy": 0.90,
    "macro_f1": 0.89,
    "calibration": {"brier_score": 0.10, "ece": 0.05},
    "latency_ms": {"p95": 100.0},
    "tokens": {"prompt_mean": 1000.0},
    "by_language": {"pl": {"accuracy": 0.90}, "en": {"accuracy": 0.90}},
    "per_quadrant": {str(index): {"f1": 0.88} for index in range(4)},
  }
  report.update(updates)
  return report


def test_regression_gate_accepts_candidate_within_versioned_policy():
  decision = evaluate_candidate(_report(), _report(accuracy=0.91), EvaluationPolicy())

  assert decision.passed is True
  assert decision.violations == []


def test_regression_gate_rejects_safety_failure_and_slice_regression():
  candidate = _report(
    injection_attack_success_rate=0.01,
    by_language={"pl": {"accuracy": 0.87}, "en": {"accuracy": 0.90}},
  )

  decision = evaluate_candidate(_report(), candidate, EvaluationPolicy())

  assert decision.passed is False
  assert any("injection" in violation for violation in decision.violations)
  assert any("language:pl" in violation for violation in decision.violations)
