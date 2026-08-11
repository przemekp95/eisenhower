from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
import json

import pytest

from app.artifacts.models import CandidateManifest, GitLineage, LineageGroup, RuntimeLineage
from app.ops.promotion import (
  PromotionBlocked,
  PromotionController,
  stable_canary_assignment,
  verify_hmac_approval,
)


def _green_report(candidate_id: str) -> dict:
  payload = {
    "schema_version": "ai-quality-drift-v1",
    "current_candidate_id": candidate_id,
    "status": "green",
    "generated_at": datetime.now(UTC).isoformat(),
  }
  encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
  return {**payload, "report_checksum": sha256(encoded).hexdigest()}


def _approval(phase: str, candidate_id: str) -> dict:
  return {
    "phase": phase,
    "candidate_id": candidate_id,
    "approved_by": "owner-out-of-band",
    "approved_at": datetime.now(UTC).isoformat(),
    "approval_source": "owner_out_of_band",
    "decision": "approved",
  }


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


def test_controller_promotes_each_phase_independently_and_rolls_back_atomically(tmp_path):
  candidates = {"rag-v1": _candidate("rag-v1"), "llm-v1": _candidate("llm-v1", "llmops")}
  controller = PromotionController(
    tmp_path / "promotion", candidate_verifier=lambda candidate_id: candidates[candidate_id],
    approval_verifier=_approval_verifier,
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
  )
  with pytest.raises(PromotionBlocked, match=match):
    controller.transition(
      phase=phase, target_mode=mode, candidate_id=candidate,
      canary_percent=5 if mode == "canary" else 0,
      quality_report=report, approval=approval, dry_run=False,
    )


def test_dry_run_does_not_write_and_canary_assignment_is_stable(tmp_path):
  controller = PromotionController(
    tmp_path / "promotion", candidate_verifier=lambda candidate_id: _candidate(candidate_id),
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
    tmp_path / "promotion", candidate_verifier=lambda candidate_id: _candidate(candidate_id),
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
