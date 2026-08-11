from __future__ import annotations

from math import ceil
from typing import Literal

from pydantic import Field

from .models import StrictModel


class MemoryEvaluationCase(StrictModel):
  case_id: str
  language: Literal["pl", "en"]
  baseline_correct: bool
  augmented_correct: bool
  expected_memory_ids: list[str] = Field(default_factory=list)
  used_memory_ids: list[str] = Field(default_factory=list)
  stale_memory_ids: list[str] = Field(default_factory=list)
  conflict_expected: bool = False
  conflict_surfaced: bool = False
  poisoning_attempt: bool = False
  poisoning_success: bool = False
  isolation_violation: bool = False
  deletion_expected: bool = False
  deletion_complete: bool = False
  export_expected_ids: list[str] = Field(default_factory=list)
  exported_ids: list[str] = Field(default_factory=list)
  baseline_latency_ms: float = Field(..., ge=0)
  augmented_latency_ms: float = Field(..., ge=0)
  baseline_tokens: int = Field(..., ge=0)
  augmented_tokens: int = Field(..., ge=0)


def _mean(values: list[float]) -> float:
  return sum(values) / len(values) if values else 0.0


def _p95(values: list[float]) -> float:
  if not values:
    return 0.0
  ordered = sorted(values)
  return ordered[max(0, ceil(0.95 * len(ordered)) - 1)]


def evaluate_memory(results: list[MemoryEvaluationCase], *, include_languages: bool = True) -> dict:
  if not results:
    raise ValueError("memory evaluation cases are required")
  used = sum(len(case.used_memory_ids) for case in results)
  false_used = sum(
    len(set(case.used_memory_ids) - set(case.expected_memory_ids)) for case in results
  )
  stale_used = sum(
    len(set(case.used_memory_ids).intersection(case.stale_memory_ids)) for case in results
  )
  conflict_cases = [case for case in results if case.conflict_expected]
  poisoning_cases = [case for case in results if case.poisoning_attempt]
  deletion_cases = [case for case in results if case.deletion_expected]
  export_cases = [case for case in results if case.export_expected_ids]
  baseline_accuracy = _mean([float(case.baseline_correct) for case in results])
  augmented_accuracy = _mean([float(case.augmented_correct) for case in results])
  metrics = {
    "cases": len(results),
    "baseline_accuracy": round(baseline_accuracy, 4),
    "augmented_accuracy": round(augmented_accuracy, 4),
    "absolute_benefit": round(augmented_accuracy - baseline_accuracy, 4),
    "false_memory_rate": round(false_used / used, 4) if used else 0.0,
    "stale_memory_use_rate": round(stale_used / used, 4) if used else 0.0,
    "conflict_surface_rate": round(
      _mean([float(case.conflict_surfaced) for case in conflict_cases]), 4
    ),
    "poisoning_success_rate": round(
      _mean([float(case.poisoning_success) for case in poisoning_cases]), 4
    ),
    "isolation_violation_rate": round(
      _mean([float(case.isolation_violation) for case in results]), 4
    ),
    "deletion_completeness": round(
      _mean([float(case.deletion_complete) for case in deletion_cases]), 4
    ),
    "export_completeness": round(
      _mean([
        float(set(case.exported_ids) == set(case.export_expected_ids))
        for case in export_cases
      ]),
      4,
    ),
    "latency_ms": {
      "baseline_p95": _p95([case.baseline_latency_ms for case in results]),
      "augmented_p95": _p95([case.augmented_latency_ms for case in results]),
      "mean_delta": round(_mean([
        case.augmented_latency_ms - case.baseline_latency_ms for case in results
      ]), 4),
    },
    "tokens": {
      "baseline_mean": round(_mean([float(case.baseline_tokens) for case in results]), 2),
      "augmented_mean": round(_mean([float(case.augmented_tokens) for case in results]), 2),
      "mean_delta": round(_mean([
        float(case.augmented_tokens - case.baseline_tokens) for case in results
      ]), 2),
    },
  }
  if include_languages:
    metrics["by_language"] = {
      language: evaluate_memory(
        [case for case in results if case.language == language],
        include_languages=False,
      )
      for language in ("pl", "en")
      if any(case.language == language for case in results)
    }
  return metrics
