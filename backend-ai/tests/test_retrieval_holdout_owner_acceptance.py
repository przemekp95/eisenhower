from __future__ import annotations

from datetime import UTC, datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path

import pytest

from app.rag.holdout_owner_acceptance import (
  HoldoutAcceptanceBlocked,
  HoldoutAcceptanceInputs,
  run_owner_accepted_holdout,
  validate_owner_acceptance,
)


NOW = datetime(2026, 8, 15, 20, 0, tzinfo=UTC)
DEADLINE = datetime(2026, 8, 15, 21, 59, 59, tzinfo=UTC)


def _write(path: Path, content: str) -> Path:
  path.write_text(content, encoding="utf-8")
  return path


def _inputs(tmp_path: Path) -> HoldoutAcceptanceInputs:
  return HoldoutAcceptanceInputs(
    candidate=_write(tmp_path / "candidate.jsonl", "candidate\n"),
    thresholds=_write(tmp_path / "thresholds.json", json.dumps({
      "k": 5,
      "global": {"recall_at_k_min": 0.9, "forbidden_hit_rate_max": 0.0},
      "required_slices": {
        "language_pl": {"recall_at_k_min": 0.85},
        "language_en": {"recall_at_k_min": 0.85},
        "split_holdout": {"recall_at_k_min": 0.85},
      },
    })),
    corpus_manifest=_write(tmp_path / "manifest.json", '{"initial_snapshot":{"sha256":"' + "a" * 64 + '"}}\n'),
    strategy_reports={
      "hybrid_reranker": _write(tmp_path / "hybrid.json", "hybrid\n"),
      "hybrid_no_reranker": _write(tmp_path / "cheap.json", "cheap\n"),
    },
    source_git_sha="b" * 40,
  )


def _receipt(inputs: HoldoutAcceptanceInputs, **updates) -> dict:
  payload = {
    "schema_version": "retrieval-holdout-owner-acceptance-v1",
    "scope": "task-048-exact-strategy-holdout-comparison-only",
    "approval_source": "owner_out_of_band",
    "authentication_level": "repository_record_only",
    "approved_by": "eisenhower-repository-owner",
    "approved_at": NOW.isoformat(),
    "valid_until": DEADLINE.isoformat(),
    "decision": "accept_missing_independent_review_for_one_holdout_run",
    "independent_human_review": False,
    "case_decisions_created": False,
    "single_use": True,
    "tuning_authorized": False,
    "promotion_authorized": False,
    "deployment_authorized": False,
    "source_baseline_git_sha": "b" * 40,
    "candidate_sha256": sha256(inputs.candidate.read_bytes()).hexdigest(),
    "thresholds_sha256": sha256(inputs.thresholds.read_bytes()).hexdigest(),
    "corpus_manifest_sha256": sha256(inputs.corpus_manifest.read_bytes()).hexdigest(),
    "corpus_snapshot_sha256": "a" * 64,
    "strategy_report_sha256": {
      name: sha256(path.read_bytes()).hexdigest()
      for name, path in inputs.strategy_reports.items()
    },
    "strategy_ids": {
      "hybrid_reranker": "hybrid-bge-v1",
      "hybrid_no_reranker": "hybrid-rrf-v1",
    },
  }
  payload.update(updates)
  return payload


def _receipt_path(tmp_path: Path, inputs: HoldoutAcceptanceInputs, **updates) -> Path:
  path = tmp_path / "acceptance.json"
  path.write_text(json.dumps(_receipt(inputs, **updates)), encoding="utf-8")
  return path


def _strategy_result(recall: float = 1.0) -> dict:
  metrics = {
    "recall_at_k": recall,
    "forbidden_hit_rate": 0.0,
    "by_language": {"pl": {"recall_at_k": recall}, "en": {"recall_at_k": recall}},
    "by_split": {"holdout": {"recall_at_k": recall}},
  }
  return {"metrics": metrics}


def _comparison(cheap_recall: float = 1.0) -> dict:
  return {
    "schema_version": "retrieval-strategy-comparison-v1",
    "evaluated_split": "holdout",
    "tuning_performed": False,
    "strategies": {
      "hybrid_reranker": _strategy_result(),
      "hybrid_no_reranker": _strategy_result(cheap_recall),
    },
  }


def test_exact_time_bounded_owner_acceptance_validates_without_claiming_human_review(tmp_path):
  inputs = _inputs(tmp_path)
  acceptance = validate_owner_acceptance(
    _receipt_path(tmp_path, inputs), inputs=inputs, now=NOW,
  )

  assert acceptance.independent_human_review is False
  assert acceptance.case_decisions_created is False
  assert acceptance.promotion_authorized is False
  assert acceptance.valid_until == DEADLINE


@pytest.mark.parametrize(
  ("updates", "message"),
  [
    ({"valid_until": NOW.isoformat()}, "expired"),
    ({"valid_until": "2026-08-15T23:59:59"}, "timezone"),
    ({"valid_until": "2026-08-16T00:00:00+02:00"}, "maximum authorized deadline"),
    ({"approved_at": (NOW + timedelta(minutes=6)).isoformat()}, "future"),
    ({"approved_by": "automation"}, "human owner"),
    ({"scope": "all-holdout-runs"}, "scope"),
    ({"decision": "approved"}, "decision"),
    ({"independent_human_review": True}, "independent_human_review"),
    ({"case_decisions_created": True}, "case_decisions_created"),
    ({"tuning_authorized": True}, "tuning_authorized"),
    ({"promotion_authorized": True}, "promotion_authorized"),
    ({"source_baseline_git_sha": "c" * 40}, "source git SHA mismatch"),
  ],
)
def test_acceptance_rejects_expiry_overreach_or_fabricated_authority(tmp_path, updates, message):
  inputs = _inputs(tmp_path)
  with pytest.raises(HoldoutAcceptanceBlocked, match=message):
    validate_owner_acceptance(
      _receipt_path(tmp_path, inputs, **updates), inputs=inputs, now=NOW,
    )


@pytest.mark.parametrize(
  "field",
  ["candidate_sha256", "thresholds_sha256", "corpus_manifest_sha256", "corpus_snapshot_sha256"],
)
def test_acceptance_rejects_bound_input_drift(tmp_path, field):
  inputs = _inputs(tmp_path)
  with pytest.raises(HoldoutAcceptanceBlocked, match="digest mismatch"):
    validate_owner_acceptance(
      _receipt_path(tmp_path, inputs, **{field: "f" * 64}), inputs=inputs, now=NOW,
    )


def test_acceptance_rejects_strategy_report_drift(tmp_path):
  inputs = _inputs(tmp_path)
  receipt = _receipt(inputs)
  receipt["strategy_report_sha256"]["hybrid_no_reranker"] = "f" * 64
  path = tmp_path / "acceptance.json"
  path.write_text(json.dumps(receipt), encoding="utf-8")

  with pytest.raises(HoldoutAcceptanceBlocked, match="strategy report digest mismatch"):
    validate_owner_acceptance(path, inputs=inputs, now=NOW)


def test_single_use_runner_rechecks_expiry_and_writes_truthful_report(tmp_path):
  inputs = _inputs(tmp_path)
  receipt = _receipt_path(tmp_path, inputs)
  output = tmp_path / "holdout-report.json"
  times = iter((NOW, NOW + timedelta(minutes=1)))

  report = run_owner_accepted_holdout(
    receipt,
    inputs=inputs,
    output=output,
    use_state_dir=tmp_path / "uses",
    evaluator=_comparison,
    now=lambda: next(times),
  )

  assert report["governance"]["approval_mode"] == "time_bounded_owner_acceptance"
  assert report["governance"]["independent_human_review_satisfied"] is False
  assert report["governance"]["promotion_authorized"] is False
  assert report["quality_gate"]["simplification_accepted"] is True
  assert json.loads(output.read_text(encoding="utf-8")) == report
  assert output.stat().st_mode & 0o777 == 0o600

  with pytest.raises(HoldoutAcceptanceBlocked, match="already exists"):
    run_owner_accepted_holdout(
      receipt, inputs=inputs, output=output, evaluator=_comparison, now=lambda: NOW,
      use_state_dir=tmp_path / "uses",
    )

  copied_receipt = tmp_path / "copied-receipt.json"
  copied_receipt.write_bytes(receipt.read_bytes())
  with pytest.raises(HoldoutAcceptanceBlocked, match="already exists"):
    run_owner_accepted_holdout(
      copied_receipt, inputs=inputs, output=tmp_path / "different.json",
      evaluator=_comparison, now=lambda: NOW,
      use_state_dir=tmp_path / "uses",
    )


def test_single_use_runner_refuses_to_commit_if_acceptance_expires_during_run(tmp_path):
  inputs = _inputs(tmp_path)
  receipt = _receipt_path(tmp_path, inputs)
  output = tmp_path / "holdout-report.json"
  times = iter((NOW, DEADLINE))

  with pytest.raises(HoldoutAcceptanceBlocked, match="expired"):
    run_owner_accepted_holdout(
      receipt,
      inputs=inputs,
      output=output,
      use_state_dir=tmp_path / "uses",
      evaluator=_comparison,
      now=lambda: next(times),
    )

  assert output.exists() is False


def test_quality_gate_rejects_simplification_and_selects_reranker_rollback(tmp_path):
  inputs = _inputs(tmp_path)
  report = run_owner_accepted_holdout(
    _receipt_path(tmp_path, inputs), inputs=inputs, output=tmp_path / "report.json",
    use_state_dir=tmp_path / "uses",
    evaluator=lambda: _comparison(cheap_recall=0.5), now=lambda: NOW,
  )

  assert report["quality_gate"]["strategies"]["hybrid_no_reranker"]["passed"] is False
  assert report["quality_gate"]["simplification_accepted"] is False
  assert report["quality_gate"]["selected_strategy"] == "hybrid_reranker"
  assert report["quality_gate"]["rollback_strategy"] == "hybrid-bge-v1"


@pytest.mark.parametrize(
  "result",
  [
    {"evaluated_split": "non_holdout", "tuning_performed": False, "strategies": {}},
    {"evaluated_split": "holdout", "tuning_performed": True, "strategies": {}},
    {
      "evaluated_split": "holdout", "tuning_performed": False,
      "strategies": {"hybrid_reranker": {}, "unexpected": {}},
    },
  ],
)
def test_single_use_runner_rejects_wrong_split_tuning_or_strategy_set(tmp_path, result):
  inputs = _inputs(tmp_path)
  with pytest.raises(HoldoutAcceptanceBlocked, match="frozen holdout comparison contract"):
    run_owner_accepted_holdout(
      _receipt_path(tmp_path, inputs),
      inputs=inputs,
      output=tmp_path / "report.json",
      use_state_dir=tmp_path / "uses",
      evaluator=lambda: result,
      now=lambda: NOW,
    )
