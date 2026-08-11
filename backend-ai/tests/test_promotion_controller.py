from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
import json

import pytest

from app.ops.promotion import PromotionBlocked, PromotionController, stable_canary_assignment


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
  }


def test_controller_promotes_each_phase_independently_and_rolls_back_atomically(tmp_path):
  controller = PromotionController(tmp_path / "promotion", candidate_verifier=lambda _candidate_id: True)
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
  controller = PromotionController(tmp_path / "promotion", candidate_verifier=lambda _candidate_id: True)
  with pytest.raises(PromotionBlocked, match=match):
    controller.transition(
      phase=phase, target_mode=mode, candidate_id=candidate,
      canary_percent=5 if mode == "canary" else 0,
      quality_report=report, approval=approval, dry_run=False,
    )


def test_dry_run_does_not_write_and_canary_assignment_is_stable(tmp_path):
  controller = PromotionController(tmp_path / "promotion", candidate_verifier=lambda _candidate_id: True)
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
