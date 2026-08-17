from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys


REPOSITORY_ROOT = Path(__file__).parents[2]
SCRIPT = REPOSITORY_ROOT / "backend-ai/scripts/rehearse_shadow_rollout.py"


def test_rehearsal_is_deterministic_fail_closed_and_does_not_claim_traffic(tmp_path: Path):
  deployment_env = tmp_path / "deployment.env"
  deployment_env.write_text(
    "\n".join((
      "AI_EVALUATION_FILE=/dev/null",
      "LOCAL_MODEL_OWNER_APPROVAL_VALID_UNTIL=2026-08-15T23:59:59+02:00",
      "RAG_RETRIEVAL_STRATEGY=hybrid-bge-v1",
      "RAG_GENERATION_ENABLED=false",
      "RAG_RESPONSE_ENABLED=false",
    )) + "\n",
    encoding="utf-8",
  )
  first = tmp_path / "first.json"
  second = tmp_path / "second.json"

  for output in (first, second):
    completed = subprocess.run(
      [
        sys.executable,
        str(SCRIPT),
        "--repository-root", str(REPOSITORY_ROOT),
        "--deployment-env", str(deployment_env),
        "--output", str(output),
        "--now", "2026-08-17T00:00:00+00:00",
      ],
      check=False,
      capture_output=True,
      text=True,
    )
    assert completed.returncode == 0, completed.stderr

  assert first.read_bytes() == second.read_bytes()
  report = json.loads(first.read_text(encoding="utf-8"))
  assert report["schema_version"] == "shadow-rollout-local-rehearsal-v1"
  assert report["effective_retrieval_only"] == {
    "generation_enabled": False,
    "memory_response_enabled": False,
    "memory_retrieval_enabled": False,
    "memory_write_enabled": False,
    "response_enabled": False,
    "retrieval_enabled": True,
    "retrieval_strategy": "hybrid-bge-v1",
  }
  assert report["pinned_reranker"] == {
    "max_model_len": 192,
    "model": "BAAI/bge-reranker-v2-m3",
    "revision": "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e",
  }
  assert report["disable_restore"]["disabled"]["retrieval_enabled"] is False
  assert report["disable_restore"]["restored_matches_initial"] is True
  assert report["post_expiry"]["decision"] == "response_approval_expired"
  assert report["post_expiry"]["metric"] == (
    'eisenhower_response_canary_decisions_total{outcome="approval_expired"} 1'
  )
  assert report["deployment_gate"] == {
    "deployment_attempted": False,
    "reason": "classifier_evaluation_missing_and_owner_approval_expired",
    "status": "blocked",
  }
  assert report["evidence_boundary"]["real_user_traffic"] is False
  assert report["evidence_boundary"]["runtime_mutated"] is False
  assert report["evidence_boundary"]["task_014_closed"] is False
  assert report["evidence_boundary"]["task_023_closed"] is False
