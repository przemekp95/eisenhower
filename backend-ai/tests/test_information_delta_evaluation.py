import pytest

from app.generation.delta_evaluation import (
  DeltaEvaluationObservation,
  evaluate_information_delta,
)


def test_information_delta_metrics_report_quality_safety_and_pl_en_slices():
  report = evaluate_information_delta([
    DeltaEvaluationObservation(
      case_id="pl-repeat",
      language="pl",
      expected_status="no_new_information",
      actual_status="no_new_information",
      repeated_claim_ids=["known-1"],
      injection_attempt=True,
      injection_success=False,
      gray_zone_abstained=True,
      latency_ms=10,
      prompt_tokens=100,
    ),
    DeltaEvaluationObservation(
      case_id="en-new",
      language="en",
      expected_status="new_information",
      actual_status="new_information",
      expected_relations={"claim-1": "new_information"},
      actual_relations={"claim-1": "new_information"},
      grounded_claim_ids=["claim-1"],
      citation_grounded_claim_ids=["claim-1"],
      latency_ms=20,
      prompt_tokens=120,
    ),
    DeltaEvaluationObservation(
      case_id="en-update",
      language="en",
      expected_status="mixed",
      actual_status="mixed",
      expected_relations={
        "claim-2": "update",
        "claim-3": "necessary_reminder",
      },
      actual_relations={
        "claim-2": "update",
        "claim-3": "necessary_reminder",
      },
      grounded_claim_ids=["claim-2", "claim-3"],
      citation_grounded_claim_ids=["claim-2"],
      latency_ms=30,
      prompt_tokens=140,
    ),
  ])

  assert report["overall"]["status_accuracy"] == 1.0
  assert report["overall"]["new_information"] == {
    "precision": 1.0,
    "recall": 1.0,
    "f1": 1.0,
  }
  assert report["overall"]["contradiction_update"]["f1"] == 1.0
  assert report["overall"]["required_reminder"]["recall"] == 1.0
  assert report["overall"]["claim_grounding_coverage"] == 1.0
  assert report["overall"]["claim_citation_coverage"] == 0.6667
  assert report["overall"]["injection_success_rate"] == 0.0
  assert report["overall"]["world_currentness_overclaim_rate"] == 0.0
  assert report["by_language"]["pl"]["cases"] == 1
  assert report["by_language"]["en"]["cases"] == 2
  assert report["overall"]["latency_ms_mean"] == 20.0


def test_information_delta_metrics_expose_repetition_and_unsupported_novelty():
  report = evaluate_information_delta([
    DeltaEvaluationObservation(
      case_id="pl-fail",
      language="pl",
      expected_status="no_new_information",
      actual_status="new_information",
      actual_relations={"known-1": "new_information"},
      repeated_claim_ids=["known-1"],
      unsupported_claim_ids=["known-1"],
      injection_attempt=True,
      injection_success=True,
      world_currentness_overclaim=True,
    )
  ])

  assert report["overall"]["status_accuracy"] == 0.0
  assert report["overall"]["repetition_escape_rate"] == 1.0
  assert report["overall"]["unsupported_claim_rate"] == 1.0
  assert report["overall"]["injection_success_rate"] == 1.0
  assert report["overall"]["world_currentness_overclaim_rate"] == 1.0


def test_information_delta_metrics_require_a_non_empty_packet():
  with pytest.raises(ValueError, match="at least one"):
    evaluate_information_delta([])
