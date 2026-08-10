from __future__ import annotations

from math import ceil

from pydantic import BaseModel, ConfigDict, Field


class EvaluationCaseResult(BaseModel):
  model_config = ConfigDict(extra="forbid")

  case_id: str
  relevant_document_ids: list[str]
  retrieved_document_ids: list[str]
  allowed_citation_ids: list[str]
  actual_citation_ids: list[str]
  expected_no_answer: bool
  actual_no_answer: bool
  grounded: bool
  latency_ms: float = Field(..., ge=0)


def _mean(values: list[float]) -> float:
  return sum(values) / len(values) if values else 0.0


def _percentile(values: list[float], percentile: float) -> float:
  if not values:
    return 0.0
  ordered = sorted(values)
  index = max(0, ceil(percentile * len(ordered)) - 1)
  return ordered[index]


def evaluate_results(results: list[EvaluationCaseResult], *, k: int) -> dict:
  if k < 1:
    raise ValueError("k must be positive")
  recalls: list[float] = []
  reciprocal_ranks: list[float] = []
  citation_scores: list[float] = []
  for result in results:
    top_k = result.retrieved_document_ids[:k]
    relevant = set(result.relevant_document_ids)
    recalls.append(len(relevant.intersection(top_k)) / len(relevant) if relevant else 1.0)
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
  latencies = [result.latency_ms for result in results]
  return {
    "cases": len(results),
    "recall_at_k": round(_mean(recalls), 4),
    "mrr": round(_mean(reciprocal_ranks), 4),
    "groundedness": round(_mean([float(result.grounded) for result in results]), 4),
    "citation_correctness": round(_mean(citation_scores), 4),
    "no_answer_accuracy": round(
      _mean([float(result.expected_no_answer == result.actual_no_answer) for result in results]),
      4,
    ),
    "latency_ms": {
      "p50": _percentile(latencies, 0.50),
      "p95": _percentile(latencies, 0.95),
      "max": max(latencies) if latencies else 0.0,
    },
  }
