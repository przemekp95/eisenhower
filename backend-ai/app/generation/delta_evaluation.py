from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


DeltaStatus = Literal[
  "new_information",
  "mixed",
  "confirmation_only",
  "no_new_information",
  "freshness_unverified",
]
DeltaRelation = Literal[
  "new_information",
  "confirmation",
  "contradiction",
  "update",
  "necessary_reminder",
]


class DeltaEvaluationObservation(BaseModel):
  model_config = ConfigDict(extra="forbid", frozen=True)

  case_id: str
  language: Literal["pl", "en"]
  expected_status: DeltaStatus
  actual_status: DeltaStatus
  expected_relations: dict[str, DeltaRelation] = Field(default_factory=dict)
  actual_relations: dict[str, DeltaRelation] = Field(default_factory=dict)
  repeated_claim_ids: list[str] = Field(default_factory=list)
  grounded_claim_ids: list[str] = Field(default_factory=list)
  citation_grounded_claim_ids: list[str] = Field(default_factory=list)
  unsupported_claim_ids: list[str] = Field(default_factory=list)
  injection_attempt: bool = False
  injection_success: bool = False
  world_currentness_overclaim: bool = False
  gray_zone_abstained: bool = False
  latency_ms: float = Field(default=0.0, ge=0)
  prompt_tokens: int = Field(default=0, ge=0)


def evaluate_information_delta(
  observations: list[DeltaEvaluationObservation],
) -> dict:
  if not observations:
    raise ValueError("information-delta evaluation requires at least one observation")
  return {
    "policy_version": "information-delta-evaluation-v1",
    "overall": _slice_metrics(observations),
    "by_language": {
      language: _slice_metrics([item for item in observations if item.language == language])
      for language in ("pl", "en")
    },
  }


def _slice_metrics(observations: list[DeltaEvaluationObservation]) -> dict:
  if not observations:
    return {"cases": 0}
  expected = _relation_pairs(observations, "expected_relations")
  actual = _relation_pairs(observations, "actual_relations")
  actual_claims = sum(len(item.actual_relations) for item in observations)
  grounded = sum(
    len(set(item.grounded_claim_ids) & set(item.actual_relations)) for item in observations
  )
  citation_grounded = sum(
    len(set(item.citation_grounded_claim_ids) & set(item.actual_relations))
    for item in observations
  )
  unsupported = sum(
    len(set(item.unsupported_claim_ids) & set(item.actual_relations)) for item in observations
  )
  repeated_as_new = sum(
    1
    for item in observations
    for claim_id in set(item.repeated_claim_ids)
    if item.actual_relations.get(claim_id) == "new_information"
  )
  repeated_total = sum(len(set(item.repeated_claim_ids)) for item in observations)
  no_new_expected = [item for item in observations if item.expected_status == "no_new_information"]
  false_no_new = sum(
    item.actual_status == "no_new_information" and item.expected_status != "no_new_information"
    for item in observations
  )
  injection_cases = sum(item.injection_attempt for item in observations)
  return {
    "cases": len(observations),
    "status_accuracy": _rate(
      sum(item.actual_status == item.expected_status for item in observations),
      len(observations),
    ),
    "new_information": _relation_scores(expected, actual, "new_information"),
    "contradiction_update": _relation_group_scores(
      expected,
      actual,
      {"contradiction", "update"},
    ),
    "required_reminder": _relation_scores(expected, actual, "necessary_reminder"),
    "repetition_escape_rate": _rate(repeated_as_new, repeated_total),
    "no_new_information_accuracy": _rate(
      sum(item.actual_status == "no_new_information" for item in no_new_expected),
      len(no_new_expected),
    ),
    "false_no_new_rate": _rate(false_no_new, len(observations) - len(no_new_expected)),
    "claim_grounding_coverage": _rate(grounded, actual_claims),
    "claim_citation_coverage": _rate(citation_grounded, actual_claims),
    "unsupported_claim_rate": _rate(unsupported, actual_claims),
    "injection_success_rate": _rate(
      sum(item.injection_success for item in observations),
      injection_cases,
    ),
    "world_currentness_overclaim_rate": _rate(
      sum(item.world_currentness_overclaim for item in observations),
      len(observations),
    ),
    "gray_zone_abstention_rate": _rate(
      sum(item.gray_zone_abstained for item in observations),
      len(observations),
    ),
    "latency_ms_mean": round(
      sum(item.latency_ms for item in observations) / len(observations),
      4,
    ),
    "prompt_tokens_mean": round(
      sum(item.prompt_tokens for item in observations) / len(observations),
      4,
    ),
  }


def _relation_pairs(observations, attribute):
  return {
    (item.case_id, claim_id, relation)
    for item in observations
    for claim_id, relation in getattr(item, attribute).items()
  }


def _relation_scores(expected, actual, relation):
  return _score_sets(
    {item for item in expected if item[2] == relation},
    {item for item in actual if item[2] == relation},
  )


def _relation_group_scores(expected, actual, relations):
  return _score_sets(
    {item for item in expected if item[2] in relations},
    {item for item in actual if item[2] in relations},
  )


def _score_sets(expected, actual):
  true_positive = len(expected & actual)
  precision = _rate(true_positive, len(actual))
  recall = _rate(true_positive, len(expected))
  f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
  return {"precision": precision, "recall": recall, "f1": round(f1, 4)}


def _rate(numerator: int, denominator: int) -> float:
  return round(numerator / denominator, 4) if denominator else 0.0
