from __future__ import annotations

from math import ceil
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class EvaluationCaseResult(BaseModel):
  model_config = ConfigDict(extra="forbid")

  case_id: str
  relevant_document_ids: list[str]
  retrieved_document_ids: list[str]
  retrieved_chunk_ids: list[str] = Field(default_factory=list)
  retrieved_content_versions: list[str] = Field(default_factory=list)
  forbidden_document_ids: list[str] = Field(default_factory=list)
  stale_document_ids: list[str] = Field(default_factory=list)
  expected_content_versions: dict[str, str] = Field(default_factory=dict)
  duplicate_hit_ids: list[str] = Field(default_factory=list)
  allowed_citation_ids: list[str]
  actual_citation_ids: list[str]
  expected_no_answer: bool
  actual_no_answer: bool
  grounded: bool
  latency_ms: float = Field(..., ge=0)
  language: Literal["pl", "en"] = "en"
  split: Literal["train", "dev", "holdout"] = "dev"
  expected_quadrant: int | None = Field(default=None, ge=0, le=3)
  actual_quadrant: int | None = Field(default=None, ge=0, le=3)
  raw_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
  schema_valid: bool = True
  injection_attempt: bool = False
  injection_success: bool = False
  result_mode: Literal["rag", "fallback", "no_answer"] = "rag"
  prompt_tokens: int = Field(default=0, ge=0)
  output_tokens: int = Field(default=0, ge=0)
  execution_id: str | None = None
  prompt_id: str | None = None
  prompt_version: str | None = None
  model_id: str | None = None
  model_revision: str | None = None
  schema_version: str | None = None


def _mean(values: list[float]) -> float:
  return sum(values) / len(values) if values else 0.0


def _percentile(values: list[float], percentile: float) -> float:
  if not values:
    return 0.0
  ordered = sorted(values)
  index = max(0, ceil(percentile * len(ordered)) - 1)
  return ordered[index]


def _scores(true_positive: int, false_positive: int, false_negative: int) -> dict[str, float]:
  precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
  recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
  f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
  return {
    "precision": round(precision, 4),
    "recall": round(recall, 4),
    "f1": round(f1, 4),
  }


def _duplicate_ids(hit_ids: list[str]) -> list[str]:
  seen: set[str] = set()
  duplicates: list[str] = []
  for hit_id in hit_ids:
    if hit_id in seen:
      duplicates.append(hit_id)
    else:
      seen.add(hit_id)
  return duplicates


def _retrieval_quality_counts(
  results: list[EvaluationCaseResult], *, k: int
) -> dict[str, int]:
  hit_count = 0
  duplicate_count = 0
  document_duplicate_count = 0
  forbidden_count = 0
  stale_count = 0
  no_hit_count = 0
  forbidden_case_count = 0
  stale_case_count = 0
  for result in results:
    document_ids = result.retrieved_document_ids[:k]
    chunk_ids = result.retrieved_chunk_ids[:k]
    content_versions = result.retrieved_content_versions[:k]
    hit_count += len(document_ids)
    no_hit_count += int(not document_ids)

    duplicate_ids = result.duplicate_hit_ids
    if not duplicate_ids:
      duplicate_ids = _duplicate_ids(chunk_ids or document_ids)
    duplicate_count += min(len(duplicate_ids), len(document_ids))
    document_duplicate_count += len(_duplicate_ids(document_ids))

    forbidden = set(result.forbidden_document_ids)
    forbidden_hits = sum(document_id in forbidden for document_id in document_ids)
    forbidden_count += forbidden_hits
    forbidden_case_count += int(forbidden_hits > 0)

    stale = set(result.stale_document_ids)
    stale_hits = 0
    for position, document_id in enumerate(document_ids):
      is_stale = document_id in stale
      expected_version = result.expected_content_versions.get(document_id)
      if expected_version is not None and position < len(content_versions):
        is_stale = is_stale or content_versions[position] != expected_version
      stale_hits += int(is_stale)
    stale_count += stale_hits
    stale_case_count += int(stale_hits > 0)
  return {
    "hits": hit_count,
    "duplicates": duplicate_count,
    "document_duplicates": document_duplicate_count,
    "forbidden": forbidden_count,
    "stale": stale_count,
    "no_hit_cases": no_hit_count,
    "forbidden_cases": forbidden_case_count,
    "stale_cases": stale_case_count,
  }


def _calibration(results: list[EvaluationCaseResult]) -> dict[str, float | int]:
  classified = [
    result
    for result in results
    if result.expected_quadrant is not None
    and result.actual_quadrant is not None
    and result.raw_confidence is not None
  ]
  if not classified:
    return {"cases": 0, "brier_score": 0.0, "ece": 0.0}
  brier = _mean([
    (result.raw_confidence - float(result.actual_quadrant == result.expected_quadrant)) ** 2
    for result in classified
  ])
  bin_count = 10
  weighted_error = 0.0
  for bin_index in range(bin_count):
    lower = bin_index / bin_count
    upper = (bin_index + 1) / bin_count
    bucket = [
      result for result in classified
      if lower <= result.raw_confidence < upper
      or (bin_index == bin_count - 1 and result.raw_confidence == 1.0)
    ]
    if not bucket:
      continue
    accuracy = _mean([
      float(result.actual_quadrant == result.expected_quadrant) for result in bucket
    ])
    confidence = _mean([float(result.raw_confidence) for result in bucket])
    weighted_error += len(bucket) / len(classified) * abs(accuracy - confidence)
  return {
    "cases": len(classified),
    "brier_score": round(brier, 4),
    "ece": round(weighted_error, 4),
  }


def evaluate_results(
  results: list[EvaluationCaseResult], *, k: int, include_slices: bool = True
) -> dict:
  if k < 1:
    raise ValueError("k must be positive")
  recalls: list[float] = []
  reciprocal_ranks: list[float] = []
  citation_scores: list[float] = []
  citation_recalls: list[float] = []
  for result in results:
    top_k = result.retrieved_document_ids[:k]
    relevant = set(result.relevant_document_ids)
    if relevant:
      recalls.append(len(relevant.intersection(top_k)) / len(relevant))
      rank = next(
        (position for position, document_id in enumerate(top_k, start=1) if document_id in relevant),
        None,
      )
      reciprocal_ranks.append(1.0 / rank if rank else 0.0)
    actual = set(result.actual_citation_ids)
    allowed = set(result.allowed_citation_ids)
    citation_scores.append(
      len(actual.intersection(allowed)) / len(actual) if actual else float(not allowed)
    )
    citation_recalls.append(
      len(actual.intersection(allowed)) / len(allowed) if allowed else float(not actual)
    )
  latencies = [result.latency_ms for result in results]
  classified = [result for result in results if result.expected_quadrant is not None]
  correct = sum(result.actual_quadrant == result.expected_quadrant for result in classified)
  per_quadrant = {}
  for quadrant in range(4):
    true_positive = sum(
      result.expected_quadrant == quadrant and result.actual_quadrant == quadrant
      for result in classified
    )
    false_positive = sum(
      result.expected_quadrant != quadrant and result.actual_quadrant == quadrant
      for result in classified
    )
    false_negative = sum(
      result.expected_quadrant == quadrant and result.actual_quadrant != quadrant
      for result in classified
    )
    per_quadrant[str(quadrant)] = _scores(true_positive, false_positive, false_negative)
  no_answer_tp = sum(result.expected_no_answer and result.actual_no_answer for result in results)
  no_answer_fp = sum(not result.expected_no_answer and result.actual_no_answer for result in results)
  no_answer_fn = sum(result.expected_no_answer and not result.actual_no_answer for result in results)
  injection_cases = [result for result in results if result.injection_attempt]
  retrieval_counts = _retrieval_quality_counts(results, k=k)
  hit_count = retrieval_counts["hits"]
  case_count = len(results)
  metrics = {
    "cases": len(results),
    "accuracy": round(correct / len(classified), 4) if classified else 0.0,
    "macro_f1": round(_mean([scores["f1"] for scores in per_quadrant.values()]), 4),
    "per_quadrant": per_quadrant,
    "recall_at_k": round(_mean(recalls), 4),
    "mrr": round(_mean(reciprocal_ranks), 4),
    "duplicate_hit_rate": round(
      retrieval_counts["duplicates"] / hit_count, 4
    ) if hit_count else 0.0,
    "document_duplicate_rate": round(
      retrieval_counts["document_duplicates"] / hit_count, 4
    ) if hit_count else 0.0,
    "freshness_rate": round(
      (hit_count - retrieval_counts["stale"]) / hit_count, 4
    ) if hit_count else 0.0,
    "stale_hit_rate": round(
      retrieval_counts["stale"] / hit_count, 4
    ) if hit_count else 0.0,
    "stale_case_rate": round(
      retrieval_counts["stale_cases"] / case_count, 4
    ) if case_count else 0.0,
    "forbidden_hit_rate": round(
      retrieval_counts["forbidden"] / hit_count, 4
    ) if hit_count else 0.0,
    "isolation_hit_rate": round(
      retrieval_counts["forbidden"] / hit_count, 4
    ) if hit_count else 0.0,
    "forbidden_case_rate": round(
      retrieval_counts["forbidden_cases"] / case_count, 4
    ) if case_count else 0.0,
    "isolation_violation_rate": round(
      retrieval_counts["forbidden_cases"] / case_count, 4
    ) if case_count else 0.0,
    "no_hit_rate": round(
      retrieval_counts["no_hit_cases"] / case_count, 4
    ) if case_count else 0.0,
    "groundedness": round(_mean([float(result.grounded) for result in results]), 4),
    "citation_correctness": round(_mean(citation_scores), 4),
    "citation_recall": round(_mean(citation_recalls), 4),
    "no_answer_accuracy": round(
      _mean([float(result.expected_no_answer == result.actual_no_answer) for result in results]),
      4,
    ),
    "no_answer": _scores(no_answer_tp, no_answer_fp, no_answer_fn),
    "schema_valid_rate": round(_mean([float(result.schema_valid) for result in results]), 4),
    "semantic_consistency": round(
      _mean([float(result.schema_valid) for result in results]), 4
    ),
    "fallback_rate": round(
      _mean([float(result.result_mode == "fallback") for result in results]), 4
    ),
    "injection_attack_success_rate": round(
      _mean([float(result.injection_success) for result in injection_cases]), 4
    ) if injection_cases else 0.0,
    "calibration": _calibration(results),
    "tokens": {
      "prompt_mean": round(_mean([result.prompt_tokens for result in results]), 2),
      "output_mean": round(_mean([result.output_tokens for result in results]), 2),
    },
    "latency_ms": {
      "p50": _percentile(latencies, 0.50),
      "p95": _percentile(latencies, 0.95),
      "max": max(latencies) if latencies else 0.0,
    },
  }
  if include_slices:
    metrics["by_language"] = {
      language: evaluate_results(
        [result for result in results if result.language == language],
        k=k,
        include_slices=False,
      )
      for language in ("pl", "en")
      if any(result.language == language for result in results)
    }
    metrics["by_split"] = {
      split: evaluate_results(
        [result for result in results if result.split == split],
        k=k,
        include_slices=False,
      )
      for split in ("train", "dev", "holdout")
      if any(result.split == split for result in results)
    }
  return metrics
