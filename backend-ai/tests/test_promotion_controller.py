from __future__ import annotations

from datetime import UTC, datetime, timedelta
from hashlib import sha256
import json
from types import SimpleNamespace

import pytest

from app.audit import AuditAction, AuditOutcome, SqliteAuditSink
from app.artifacts.models import CandidateManifest, GitLineage, LineageGroup, RuntimeLineage
from app.ops.promotion import (
  PromotionBlocked,
  PromotionController,
  stable_canary_assignment,
  verify_hmac_approval,
)
from scripts.ai_promotion import _load_audit_sink


def test_promotion_cli_requires_complete_durable_audit_config_for_apply(tmp_path):
  args = SimpleNamespace(
    apply=True,
    audit_database=None,
    audit_key_file=None,
    release_sha=None,
  )
  with pytest.raises(PromotionBlocked, match="requires --audit-database"):
    _load_audit_sink(args)

  key_path = tmp_path / "audit.key"
  key_path.write_bytes(b"cli-audit-key-with-at-least-thirty-two-bytes")
  key_path.chmod(0o600)
  args.audit_database = tmp_path / "audit.sqlite3"
  args.audit_key_file = key_path
  args.release_sha = "f" * 40

  sink = _load_audit_sink(args)
  assert sink is not None
  sink.close()


def _green_report(candidate_id: str) -> dict:
  payload = {
    "schema_version": "ai-quality-drift-v1",
    "current_candidate_id": candidate_id,
    "status": "green",
    "generated_at": datetime.now(UTC).isoformat(),
  }
  encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
  return {**payload, "report_checksum": sha256(encoded).hexdigest()}


def _knowledge_answer_report(candidate_id: str) -> dict:
  payload = {
    "schema_version": "knowledge-answer-holdout-report-v1",
    "dataset_version": "knowledge-answer-holdout-v1",
    "dataset_checksum": "a" * 64,
    "policy_version": "knowledge-answer-holdout-policy-v1",
    "policy_checksum": "b" * 64,
    "current_candidate_id": candidate_id,
    "git_sha": "d" * 40,
    "evidence_level": "physical_local_amd_runtime_holdout",
    "status": "green",
    "failed_gates": [],
    "metrics": {"cases": 24},
    "lineage": {
      "prompt_id": "knowledge-answer",
      "prompt_version": "1.0.0",
      "model_id": "Qwen/Qwen3-4B-Instruct-2507",
      "model_revision": "revision-1",
      "schema_version": "1.0.0",
    },
    "generated_at": datetime.now(UTC).isoformat(),
    "human_review": {"required_for_production": True, "satisfied": False},
    "production_quality_proven": False,
  }
  encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
  return {**payload, "report_checksum": sha256(encoded).hexdigest()}


def _approval(phase: str, candidate_id: str, *, valid_until: datetime | None = None) -> dict:
  approval = {
    "phase": phase,
    "candidate_id": candidate_id,
    "approved_by": "owner-out-of-band",
    "approved_at": datetime.now(UTC).isoformat(),
    "approval_source": "owner_out_of_band",
    "decision": "approved",
  }
  if valid_until is not None:
    approval["valid_until"] = valid_until.isoformat()
  return approval


def _candidate(candidate_id: str, workflow: str = "ragops") -> CandidateManifest:
  return CandidateManifest.create(
    candidate_id=candidate_id,
    workflow=workflow,
    evidence_level="ci_in_process",
    created_at=datetime.now(UTC),
    git=GitLineage(commit_sha="d" * 40, dirty=False),
    datasets=LineageGroup(not_applicable_reason="not used by this test candidate"),
    models=LineageGroup(not_applicable_reason="not used by this test candidate"),
    prompts=LineageGroup(not_applicable_reason="not used by this test candidate"),
    schemas=LineageGroup(not_applicable_reason="not used by this test candidate"),
    corpora=LineageGroup(not_applicable_reason="not used by this test candidate"),
    qdrant_collections=LineageGroup(not_applicable_reason="not used by this test candidate"),
    runtimes=(RuntimeLineage(name="test", version="1", digest="e" * 64),),
    reports=LineageGroup(not_applicable_reason="not used by this test candidate"),
  )


def _approval_verifier(approval: dict) -> bool:
  return approval.get("approval_source") == "owner_out_of_band"


def _audit_sink(tmp_path):
  return SqliteAuditSink(
    tmp_path / "audit.sqlite3",
    hmac_key=b"promotion-audit-test-key-at-least-32-bytes",
  )


def test_applied_transition_and_rollback_are_audited_without_candidate_or_actor_leakage(tmp_path):
  sink = _audit_sink(tmp_path)
  controller = PromotionController(
    tmp_path / "promotion",
    candidate_verifier=_candidate,
    approval_verifier=_approval_verifier,
    audit_sink=sink,
    release_sha="d" * 40,
  )

  controller.transition(
    phase="retrieval", target_mode="shadow", candidate_id="rag-v1", canary_percent=0,
    quality_report=_green_report("rag-v1"), approval=_approval("retrieval", "rag-v1"),
    dry_run=False, request_id="request-transition",
  )
  controller.rollback(actor_id="release-owner", request_id="request-rollback")

  records = sink.query(limit=20)
  assert [(record.action, record.outcome) for record in records] == [
    (AuditAction.ROLLOUT_DECISION, AuditOutcome.ATTEMPT),
    (AuditAction.ROLLOUT_DECISION, AuditOutcome.SUCCESS),
    (AuditAction.ROLLBACK_DECISION, AuditOutcome.ATTEMPT),
    (AuditAction.ROLLBACK_DECISION, AuditOutcome.SUCCESS),
  ]
  assert [record.request_id for record in records] == [
    "request-transition", "request-transition", "request-rollback", "request-rollback"
  ]
  database_bytes = sink.path.read_bytes()
  assert b"rag-v1" not in database_bytes
  assert b"owner-out-of-band" not in database_bytes
  assert b"release-owner" not in database_bytes


def test_applied_transition_fails_closed_before_validation_or_pointer_write_when_audit_fails(tmp_path):
  sink = _audit_sink(tmp_path)
  sink.close()
  verifier_calls = []
  controller = PromotionController(
    tmp_path / "promotion",
    candidate_verifier=verifier_calls.append,
    approval_verifier=_approval_verifier,
    audit_sink=sink,
    release_sha="d" * 40,
  )
  before = controller.read()

  with pytest.raises(PromotionBlocked, match="audit"):
    controller.transition(
      phase="retrieval", target_mode="shadow", candidate_id="rag-v1", canary_percent=0,
      quality_report=_green_report("rag-v1"), approval=_approval("retrieval", "rag-v1"),
      dry_run=False, request_id="request-transition",
    )

  assert not verifier_calls
  assert controller.read() == before


def test_rejected_transition_is_audited_and_does_not_change_pointer(tmp_path):
  sink = _audit_sink(tmp_path)
  controller = PromotionController(
    tmp_path / "promotion",
    candidate_verifier=_candidate,
    approval_verifier=_approval_verifier,
    audit_sink=sink,
    release_sha="d" * 40,
  )
  before = controller.read()

  with pytest.raises(PromotionBlocked, match="quality"):
    controller.transition(
      phase="retrieval", target_mode="shadow", candidate_id="rag-v1", canary_percent=0,
      quality_report={**_green_report("rag-v1"), "status": "blocked"},
      approval=_approval("retrieval", "rag-v1"), dry_run=False,
      request_id="request-rejected",
    )

  assert controller.read() == before
  records = sink.query(limit=10)
  assert [(record.action, record.outcome) for record in records] == [
    (AuditAction.ROLLOUT_DECISION, AuditOutcome.ATTEMPT),
    (AuditAction.ROLLOUT_DECISION, AuditOutcome.REJECTED),
  ]


def test_controller_promotes_each_phase_independently_and_rolls_back_atomically(tmp_path):
  candidates = {"rag-v1": _candidate("rag-v1"), "llm-v1": _candidate("llm-v1", "llmops")}
  controller = PromotionController(
    tmp_path / "promotion", candidate_verifier=lambda candidate_id: candidates[candidate_id],
    approval_verifier=_approval_verifier,
    audit_sink=_audit_sink(tmp_path), release_sha="d" * 40,
  )
  initial = controller.read()
  assert {phase: value["mode"] for phase, value in initial["phases"].items()} == {
    "retrieval": "disabled", "generation": "disabled", "response": "disabled", "mag": "disabled",
  }

  retrieval = controller.transition(
    phase="retrieval", target_mode="shadow", candidate_id="rag-v1", canary_percent=0,
    quality_report=_green_report("rag-v1"), approval=_approval("retrieval", "rag-v1"), dry_run=False,
  )
  assert retrieval["phases"]["retrieval"]["mode"] == "shadow"
  assert retrieval["phases"]["generation"]["mode"] == "disabled"
  generation = controller.transition(
    phase="generation", target_mode="shadow", candidate_id="llm-v1", canary_percent=0,
    quality_report=_green_report("llm-v1"), approval=_approval("generation", "llm-v1"), dry_run=False,
  )
  assert generation["phases"]["generation"]["mode"] == "shadow"
  rolled_back = controller.rollback()
  assert rolled_back == retrieval


def test_response_canary_requires_checksum_bound_knowledge_answer_holdout(tmp_path):
  candidates = {
    "rag-v1": _candidate("rag-v1"),
    "llm-v1": _candidate("llm-v1", "llmops"),
    "answer-v1": _candidate("answer-v1", "llmops"),
  }
  controller = PromotionController(
    tmp_path / "promotion", candidate_verifier=lambda candidate_id: candidates[candidate_id],
    approval_verifier=_approval_verifier,
    audit_sink=_audit_sink(tmp_path), release_sha="d" * 40,
  )
  for phase, candidate in (
    ("retrieval", "rag-v1"),
    ("generation", "llm-v1"),
    ("response", "answer-v1"),
  ):
    controller.transition(
      phase=phase, target_mode="shadow", candidate_id=candidate, canary_percent=0,
      quality_report=_green_report(candidate), approval=_approval(phase, candidate), dry_run=False,
    )

  with pytest.raises(PromotionBlocked, match="knowledge-answer holdout"):
    controller.transition(
      phase="response", target_mode="canary", candidate_id="answer-v1", canary_percent=5,
      quality_report=_green_report("answer-v1"),
      approval=_approval("response", "answer-v1"), dry_run=True,
    )

  planned = controller.transition(
    phase="response", target_mode="canary", candidate_id="answer-v1", canary_percent=5,
    quality_report=_knowledge_answer_report("answer-v1"),
    approval=_approval(
      "response", "answer-v1", valid_until=datetime.now(UTC) + timedelta(days=3)
    ), dry_run=True,
  )
  assert planned["phases"]["response"]["mode"] == "canary"
  assert planned["phases"]["response"]["approval_valid_until"]


def test_response_canary_rejects_missing_or_expired_approval_window(tmp_path):
  controller = PromotionController(
    tmp_path / "promotion",
    candidate_verifier=lambda candidate_id: _candidate(candidate_id, "llmops"),
    approval_verifier=_approval_verifier,
  )
  current = controller.read()
  current["phases"]["retrieval"]["mode"] = "shadow"
  current["phases"]["generation"]["mode"] = "shadow"
  current["phases"]["response"] = {
    "mode": "shadow", "candidate_id": "answer-v1", "canary_percent": 0
  }
  controller._write(current)

  for approval in (
    _approval("response", "answer-v1"),
    _approval("response", "answer-v1", valid_until=datetime.now(UTC) - timedelta(seconds=1)),
  ):
    with pytest.raises(PromotionBlocked, match="approval window"):
      controller.transition(
        phase="response", target_mode="canary", candidate_id="answer-v1", canary_percent=5,
        quality_report=_knowledge_answer_report("answer-v1"), approval=approval, dry_run=True,
      )


@pytest.mark.parametrize(
  ("phase", "mode", "candidate", "report", "approval", "match"),
  [
    ("generation", "shadow", "llm-v1", _green_report("llm-v1"), _approval("generation", "llm-v1"), "dependency"),
    ("retrieval", "canary", "rag-v1", _green_report("rag-v1"), _approval("retrieval", "rag-v1"), "transition"),
    ("retrieval", "shadow", "rag-v1", {**_green_report("rag-v1"), "status": "blocked"}, _approval("retrieval", "rag-v1"), "quality"),
    ("retrieval", "shadow", "rag-v1", _green_report("other"), _approval("retrieval", "rag-v1"), "candidate"),
    ("retrieval", "shadow", "rag-v1", _green_report("rag-v1"), _approval("response", "rag-v1"), "approval"),
  ],
)
def test_controller_fails_closed_on_dependency_transition_evidence_or_approval(
  tmp_path, phase, mode, candidate, report, approval, match
):
  controller = PromotionController(
    tmp_path / "promotion", candidate_verifier=lambda candidate_id: _candidate(
      candidate_id, "llmops" if candidate_id.startswith("llm-") else "ragops"
    ),
    approval_verifier=_approval_verifier,
    audit_sink=_audit_sink(tmp_path), release_sha="d" * 40,
  )
  with pytest.raises(PromotionBlocked, match=match):
    controller.transition(
      phase=phase, target_mode=mode, candidate_id=candidate,
      canary_percent=5 if mode == "canary" else 0,
      quality_report=report, approval=approval, dry_run=False,
    )


def test_dry_run_does_not_write_and_canary_assignment_is_stable(tmp_path):
  controller = PromotionController(
    tmp_path / "promotion", candidate_verifier=_candidate,
    approval_verifier=_approval_verifier,
  )
  before = controller.read()
  planned = controller.transition(
    phase="retrieval", target_mode="shadow", candidate_id="rag-v1", canary_percent=0,
    quality_report=_green_report("rag-v1"), approval=_approval("retrieval", "rag-v1"), dry_run=True,
  )
  assert planned["phases"]["retrieval"]["mode"] == "shadow"
  assert controller.read() == before
  first = stable_canary_assignment("pseudonymous-subject", "rag-v1", "retrieval", 5)
  assert first == stable_canary_assignment("pseudonymous-subject", "rag-v1", "retrieval", 5)
  assert stable_canary_assignment("pseudonymous-subject", "rag-v1", "retrieval", 0) is False


@pytest.mark.parametrize("workflow", ["monitoring", "llmops", "mlops", "promotion"])
def test_controller_rejects_candidate_workflow_that_does_not_match_phase(tmp_path, workflow):
  controller = PromotionController(
    tmp_path / "promotion", candidate_verifier=lambda candidate_id: _candidate(candidate_id, workflow),
    approval_verifier=_approval_verifier,
  )
  with pytest.raises(PromotionBlocked, match="workflow"):
    controller.transition(
      phase="retrieval", target_mode="shadow", candidate_id="rag-v1", canary_percent=0,
      quality_report=_green_report("rag-v1"), approval=_approval("retrieval", "rag-v1"), dry_run=True,
    )


@pytest.mark.parametrize(
  "approval",
  [
    {**_approval("retrieval", "rag-v1"), "approved_at": "not-a-date"},
    {**_approval("retrieval", "rag-v1"), "approved_by": "self"},
    {**_approval("retrieval", "rag-v1"), "approval_source": "ci"},
    {**_approval("retrieval", "rag-v1"), "decision": "pending"},
  ],
)
def test_controller_rejects_malformed_or_non_owner_approval(tmp_path, approval):
  controller = PromotionController(
    tmp_path / "promotion", candidate_verifier=_candidate,
    approval_verifier=_approval_verifier,
  )
  with pytest.raises(PromotionBlocked, match="approval"):
    controller.transition(
      phase="retrieval", target_mode="shadow", candidate_id="rag-v1", canary_percent=0,
      quality_report=_green_report("rag-v1"), approval=approval, dry_run=True,
    )


def test_hmac_approval_verifier_rejects_tampering():
  approval = _approval("retrieval", "rag-v1")
  key = b"owner-controlled-approval-key-32-bytes-minimum"
  payload = json.dumps(approval, sort_keys=True, separators=(",", ":")).encode()
  approval["signature"] = __import__("hmac").new(key, payload, sha256).hexdigest()

  assert verify_hmac_approval(approval, key) is True
  assert verify_hmac_approval({**approval, "candidate_id": "other"}, key) is False
