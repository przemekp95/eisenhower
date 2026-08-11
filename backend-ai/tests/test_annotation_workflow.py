import pytest

from app.evaluation import (
  annotation_agreement,
  evaluation_governance_issues,
  finalize_dual_annotations,
  freeze_evaluation_candidate,
)


def balanced_pool():
  return [
    {
      "id": f"{language}-{intended_quadrant}-{index:02d}",
      "language": language,
      "text": f"{language} independent task {intended_quadrant} {index}",
      "semantic_group_id": f"scenario-{language}-{intended_quadrant}-{index:02d}",
    }
    for language in ("en", "pl")
    for intended_quadrant in range(4)
    for index in range(30)
  ]


def labels_for_pool(pool):
  return {item["id"]: int(item["id"].split("-")[1]) for item in pool}


def test_annotation_agreement_reports_observed_agreement_and_cohen_kappa():
  report = annotation_agreement(
    {"a": 0, "b": 1, "c": 2, "d": 3, "e": 0},
    {"a": 0, "b": 1, "c": 2, "d": 2, "e": 0},
  )

  assert report["sample_count"] == 5
  assert report["agreement_count"] == 4
  assert report["raw_agreement"] == 0.8
  assert 0 < report["cohen_kappa"] < 1
  assert report["disagreement_ids"] == ["d"]


def test_annotation_agreement_rejects_incomplete_or_invalid_decisions():
  with pytest.raises(ValueError, match="same example ids"):
    annotation_agreement({"a": 0}, {"b": 0})

  with pytest.raises(ValueError, match="range 0..3"):
    annotation_agreement({"a": 4}, {"a": 0})


def test_finalize_dual_annotations_builds_pending_dataset_with_auditable_evidence():
  pool = balanced_pool()
  annotator_a = labels_for_pool(pool)
  annotator_b = dict(annotator_a)
  annotator_b["en-0-00"] = 1

  dataset = finalize_dual_annotations(
    pool,
    annotator_a,
    annotator_b,
    adjudication={"en-0-00": 0},
    dataset_name="eisenhower-production-v1-candidate",
    annotator_a_sha256="a" * 64,
    annotator_b_sha256="b" * 64,
    pool_sha256="c" * 64,
  )

  assert len(dataset["examples"]) == 240
  assert dataset["governance"]["status"] == "pending_human_approval"
  assert dataset["governance"]["frozen"] is False
  assert dataset["governance"]["independent_annotators"] == 2
  assert dataset["governance"]["annotation_evidence"]["cohen_kappa"] >= 0.80
  assert dataset["governance"]["annotation_evidence"]["raw_agreement"] >= 0.80
  assert dataset["governance"]["annotation_evidence"]["annotator_a_sha256"] == "a" * 64
  assert dataset["examples"][0]["quadrant"] == 0


def test_finalize_dual_annotations_accepts_the_human_packet_task_and_context_shape():
  pool = balanced_pool()
  packet_pool = [
    {
      "id": item["id"],
      "language": item["language"],
      "task": item["text"],
      "context": f"Independent context for {item['id']}",
    }
    for item in pool
  ]
  labels = labels_for_pool(pool)

  dataset = finalize_dual_annotations(
    packet_pool,
    labels,
    dict(labels),
    adjudication={},
    dataset_name="packet-candidate",
    annotator_a_sha256="a" * 64,
    annotator_b_sha256="b" * 64,
    pool_sha256="c" * 64,
  )

  assert dataset["examples"][0]["text"] == (
    "en independent task 0 0\nContext: Independent context for en-0-00"
  )


def test_finalize_dual_annotations_requires_adjudication_for_exactly_the_disagreements():
  pool = balanced_pool()
  annotator_a = labels_for_pool(pool)
  annotator_b = dict(annotator_a)
  annotator_b["en-0-00"] = 1

  with pytest.raises(ValueError, match="exactly the disagreement ids"):
    finalize_dual_annotations(
      pool,
      annotator_a,
      annotator_b,
      adjudication={},
      dataset_name="candidate",
      annotator_a_sha256="a" * 64,
      annotator_b_sha256="b" * 64,
      pool_sha256="c" * 64,
    )


def test_finalize_dual_annotations_fails_closed_below_kappa_threshold():
  pool = balanced_pool()
  annotator_a = labels_for_pool(pool)
  annotator_b = {item["id"]: (annotator_a[item["id"]] + 1) % 4 for item in pool}

  with pytest.raises(ValueError, match="Cohen kappa"):
    finalize_dual_annotations(
      pool,
      annotator_a,
      annotator_b,
      adjudication={item["id"]: annotator_a[item["id"]] for item in pool},
      dataset_name="candidate",
      annotator_a_sha256="a" * 64,
      annotator_b_sha256="b" * 64,
      pool_sha256="c" * 64,
      minimum_raw_agreement=0.0,
    )


def test_finalize_dual_annotations_fails_closed_below_raw_agreement_threshold():
  pool = balanced_pool()
  annotator_a = labels_for_pool(pool)
  annotator_b = dict(annotator_a)
  for item in pool[:49]:
    annotator_b[item["id"]] = (annotator_a[item["id"]] + 1) % 4

  with pytest.raises(ValueError, match="Raw agreement"):
    finalize_dual_annotations(
      pool,
      annotator_a,
      annotator_b,
      adjudication={item["id"]: annotator_a[item["id"]] for item in pool[:49]},
      dataset_name="candidate",
      annotator_a_sha256="a" * 64,
      annotator_b_sha256="b" * 64,
      pool_sha256="c" * 64,
    )


def test_finalize_dual_annotations_rejects_a_final_underrepresented_slice():
  pool = balanced_pool()
  annotator_a = labels_for_pool(pool)
  for item in pool:
    if item["language"] == "pl" and annotator_a[item["id"]] == 3:
      annotator_a[item["id"]] = 2

  with pytest.raises(ValueError, match="language/class slice"):
    finalize_dual_annotations(
      pool,
      annotator_a,
      dict(annotator_a),
      adjudication={},
      dataset_name="candidate",
      annotator_a_sha256="a" * 64,
      annotator_b_sha256="b" * 64,
      pool_sha256="c" * 64,
    )


def test_freeze_requires_named_human_approval_and_makes_governance_auditable():
  pool = balanced_pool()
  labels = labels_for_pool(pool)
  candidate = finalize_dual_annotations(
    pool,
    labels,
    dict(labels),
    adjudication={},
    dataset_name="eisenhower-production-v1",
    annotator_a_sha256="a" * 64,
    annotator_b_sha256="b" * 64,
    pool_sha256="c" * 64,
  )

  with pytest.raises(ValueError, match="human approver"):
    freeze_evaluation_candidate(candidate, approver_id="", approved_at="2026-08-10T12:00:00Z")

  frozen = freeze_evaluation_candidate(
    candidate,
    approver_id="human-reviewer-1",
    approved_at="2026-08-10T12:00:00Z",
  )

  assert frozen["governance"]["status"] == "approved"
  assert frozen["governance"]["frozen"] is True
  assert frozen["governance"]["approved_by"] == "human-reviewer-1"
  assert not evaluation_governance_issues(frozen, profile="production")
