from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "rehearse-node-transport-rollback.mjs"
RUNBOOK = ROOT / "docs" / "runbooks" / "node-transport-rollback.md"
EVIDENCE = ROOT / "docs" / "evidence" / "2026-08-23-node-transport-rollback.md"
BASELINE = "5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9"


def test_rollback_rehearsal_has_an_executable_and_safe_runbook():
  script = SCRIPT.read_text(encoding="utf-8")
  runbook = RUNBOOK.read_text(encoding="utf-8")

  assert "MongoMemoryReplSet" in script
  assert "git archive" in script or "['archive'" in script
  assert "finally" in script
  assert "SIGTERM" in script and "SIGKILL" in script
  assert "Nest -> Express -> Nest" in runbook
  assert BASELINE in runbook
  assert "bez migracji danych" in runbook.lower()
  assert "rollback" in runbook.lower()


def test_captured_rollback_evidence_proves_each_shared_data_phase():
  evidence = EVIDENCE.read_text(encoding="utf-8")

  assert f"Baseline SHA: `{BASELINE}`" in evidence
  assert re.search(r"Candidate SHA: `[a-f0-9]{40}`", evidence)
  assert "Shared database URI:" in evidence
  assert "Migration commands: `none`" in evidence
  assert "Nest initial exit: `0`" in evidence
  assert "Express rollback exit: `0`" in evidence
  assert "Nest restored exit: `0`" in evidence
  assert "Task revision before rollback: `1`" in evidence
  assert "Task revision written by Express: `2`" in evidence
  assert "Task revision after restore: `2`" in evidence
  assert "Idempotency replay across all phases: `passed`" in evidence
  assert "Calendar binding across all phases: `passed`" in evidence
  assert "Outbox lease survived rollback: `passed`" in evidence
  assert "Outbox reconciliation after restore: `delivered`" in evidence
  assert "Overall exit: `0`" in evidence
