from __future__ import annotations

from collections import defaultdict
import math

from pydantic import BaseModel, ConfigDict, Field

from app.ci_impact.models import HistoryRecord, LabelValue


class EvaluationCase(BaseModel):
  model_config = ConfigDict(extra="forbid", frozen=True)
  epoch: str = Field(..., min_length=1, max_length=128)
  additional_epochs: tuple[str, ...] = ()
  probabilities: dict[str, float]
  selected_jobs: tuple[str, ...]
  labels: dict[str, LabelValue]
  abstain: bool
  change_fingerprint: str | None = None


class JobMetrics(BaseModel):
  model_config = ConfigDict(extra="forbid", frozen=True)
  required_support: int
  safe_to_skip_support: int
  required_job_recall: float | None
  unsafe_skip_rate: float | None
  precision: float | None
  brier_score: float | None
  expected_calibration_error: float | None


class EvaluationReport(BaseModel):
  model_config = ConfigDict(extra="forbid", frozen=True)
  schema_version: str = "ci-impact-evaluation-v1"
  per_job: dict[str, JobMetrics]
  baseline_per_job: dict[str, JobMetrics]
  abstention_coverage: float
  selective_coverage: float
  stability: float | None
  epoch_coverage: tuple[str, ...]
  case_count: int


def temporal_holdout(
  records: tuple[HistoryRecord, ...], *, holdout_fraction: float
) -> tuple[tuple[HistoryRecord, ...], tuple[HistoryRecord, ...]]:
  if len(records) < 2 or not 0 < holdout_fraction < 1:
    raise ValueError("temporal holdout needs at least two records and a bounded fraction")
  ordered = tuple(sorted(records, key=lambda item: (item.merged_at, item.pull_request_number)))
  holdout_size = max(1, math.ceil(len(ordered) * holdout_fraction))
  if holdout_size >= len(ordered):
    raise ValueError("temporal holdout would leave no training records")
  return ordered[:-holdout_size], ordered[-holdout_size:]


def evaluate(
  cases: tuple[EvaluationCase, ...],
  *,
  required_epochs: tuple[str, ...],
  baseline_cases: tuple[EvaluationCase, ...] | None = None,
  stability_cases: tuple[EvaluationCase, ...] | None = None,
) -> EvaluationReport:
  if not cases:
    raise ValueError("evaluation requires cases")
  covered = tuple(dict.fromkeys(epoch for case in cases for epoch in (case.epoch, *case.additional_epochs)))
  missing = set(required_epochs) - set(covered)
  if missing:
    raise ValueError(f"evaluation is missing required epochs: {', '.join(sorted(missing))}")
  if any(not 0 <= probability <= 1 for case in cases for probability in case.probabilities.values()):
    raise ValueError("evaluation probabilities must be between zero and one")
  stability = _stability(stability_cases or cases)
  return EvaluationReport(
    per_job=_per_job(cases),
    baseline_per_job=_per_job(baseline_cases) if baseline_cases else {},
    abstention_coverage=sum(case.abstain for case in cases) / len(cases),
    selective_coverage=sum(not case.abstain for case in cases) / len(cases),
    stability=stability,
    epoch_coverage=covered,
    case_count=len(cases),
  )


def _per_job(cases: tuple[EvaluationCase, ...]) -> dict[str, JobMetrics]:
  jobs = sorted({job for case in cases for job in case.labels})
  result: dict[str, JobMetrics] = {}
  for job in jobs:
    reviewed = [case for case in cases if case.labels.get(job) in {"required", "safe_to_skip"}]
    required = [case for case in reviewed if case.labels[job] == "required"]
    safe = [case for case in reviewed if case.labels[job] == "safe_to_skip"]
    selected = [case for case in reviewed if job in case.selected_jobs]
    true_selected = sum(case.labels[job] == "required" for case in selected)
    recall = sum(job in case.selected_jobs for case in required) / len(required) if required else None
    targets_and_probabilities = [
      (float(case.labels[job] == "required"), case.probabilities[job])
      for case in reviewed if job in case.probabilities
    ]
    result[job] = JobMetrics(
      required_support=len(required),
      safe_to_skip_support=len(safe),
      required_job_recall=recall,
      unsafe_skip_rate=(1 - recall) if recall is not None else None,
      precision=true_selected / len(selected) if selected else None,
      brier_score=(
        sum((probability - target) ** 2 for target, probability in targets_and_probabilities)
        / len(targets_and_probabilities)
        if targets_and_probabilities else None
      ),
      expected_calibration_error=_ece(targets_and_probabilities),
    )
  return result


def _ece(values: list[tuple[float, float]], bins: int = 10) -> float | None:
  if not values:
    return None
  total = len(values)
  error = 0.0
  for index in range(bins):
    lower, upper = index / bins, (index + 1) / bins
    bucket = [item for item in values if lower <= item[1] < upper or (index == bins - 1 and item[1] == 1)]
    if bucket:
      accuracy = sum(target for target, _ in bucket) / len(bucket)
      confidence = sum(probability for _, probability in bucket) / len(bucket)
      error += len(bucket) / total * abs(accuracy - confidence)
  return error


def _stability(cases: tuple[EvaluationCase, ...]) -> float | None:
  groups: dict[str, list[EvaluationCase]] = defaultdict(list)
  for case in cases:
    if case.change_fingerprint:
      groups[case.change_fingerprint].append(case)
  repeated = [group for group in groups.values() if len(group) > 1]
  if not repeated:
    return None
  spreads: list[float] = []
  for group in repeated:
    jobs = set.intersection(*(set(case.probabilities) for case in group))
    spreads.extend(max(case.probabilities[job] for case in group) - min(case.probabilities[job] for case in group) for job in jobs)
  return 1 - max(spreads) if spreads else None
