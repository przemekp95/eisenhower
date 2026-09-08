from __future__ import annotations

from datetime import UTC, datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

import pytest

from app.ops.private_rag_activation import (
  ActivationBlocked,
  PrivateRagActivationInputs,
  build_private_rag_activation,
  write_private_rag_activation,
)


NOW = datetime(2026, 8, 19, 12, 0, tzinfo=UTC)
USER_ID = "f226f9de-1c01-4a36-9eb3-77f3313e3456"
ALTERNATE_USER_ID = "a35c57d4-00bc-43aa-9d5b-c3bde96e00a5"
GIT_SHA = "a" * 40
IMAGE_DIGEST = "registry.example/eisenhower-ai-response-rocm@sha256:" + "b" * 64


def _write(path, content: str):
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(content, encoding="utf-8")
  return path


def _inputs(tmp_path, **updates) -> PrivateRagActivationInputs:
  manifest = _write(tmp_path / "corpus.json", '{"manifest_version":"eisenhower-corpus-v1"}\n')
  snapshot = _write(tmp_path / "projection.snapshot", "approved projection\n")
  ragops = _write(tmp_path / "ragops.json", '{"status":"green"}\n')
  answer = _write(tmp_path / "answer.json", '{"status":"green"}\n')
  approval_payload = {
    "schema_version": "private-rag-owner-approval-v1",
    "approved_by": "eisenhower-repository-owner",
    "approved_at": NOW.isoformat(),
    "valid_until": (NOW + timedelta(days=7)).isoformat(),
    "decision": "activate_private_single_turn_grounded_response",
    "source_git_sha": GIT_SHA,
    "corpus_manifest_sha256": sha256(manifest.read_bytes()).hexdigest(),
    "corpus_snapshot_sha256": sha256(snapshot.read_bytes()).hexdigest(),
    "ragops_report_sha256": sha256(ragops.read_bytes()).hexdigest(),
    "answer_report_sha256": sha256(answer.read_bytes()).hexdigest(),
    "tenant_id": "eisenhower-owner",
    "project_ids": ["eisenhower"],
    "response_users": [USER_ID],
    "collection": "eisenhower-knowledge-task065-candidate",
    "canonical_document_count": 24,
    "projection_point_count": 118,
    "models": {
      "generator": {
        "name": "Qwen/Qwen3-4B-Instruct-2507",
        "revision": "2a09d26efb0d53e74bc2e91f2fe2785b6f032bca",
        "image_digest": IMAGE_DIGEST,
      },
      "reranker": {
        "name": "BAAI/bge-reranker-v2-m3",
        "revision": "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e",
        "image_digest": IMAGE_DIGEST,
      },
      "embedding": {
        "name": "BAAI/bge-m3",
        "revision": "5617a9f61b028005a4858fdac845db406aefb181",
      },
    },
    "prompt_version": "1.2.0",
    "knowledge_prompt_version": "1.0.0",
    "stop_thresholds": {
      "maximum_p95_seconds": 15.0,
      "maximum_error_rate": 0.05,
      "maximum_circuit_open_events": 1,
      "minimum_citation_validity": 1.0,
      "minimum_no_answer_precision": 1.0,
      "minimum_no_answer_recall": 1.0,
    },
    "rollback": {
      "primary_project": "eisenhower-e2eff0",
      "primary_loopback": "127.0.0.1:8990",
      "secondary_project": "eisenhower-ddb83c",
      "secondary_loopback": "127.0.0.1:8890",
    },
    "memory": {"write": False, "retrieval": False, "response": False},
    "mag_mode": "disabled",
    "public_release_authorized": False,
  }
  approval_payload.update(updates.pop("approval_updates", {}))
  approval = _write(tmp_path / "approval.json", json.dumps(approval_payload))
  values = {
    "approval": approval,
    "corpus_manifest": manifest,
    "corpus_snapshot": snapshot,
    "ragops_report": ragops,
    "answer_report": answer,
    "source_git_sha": GIT_SHA,
    "git_dirty": False,
  }
  values.update(updates)
  return PrivateRagActivationInputs(**values)


def test_receipt_binds_final_sha_manifest_models_cohort_and_disabled_memory(tmp_path):
  receipt = build_private_rag_activation(_inputs(tmp_path), now=NOW)

  assert receipt.schema_version == "private-rag-activation-v1"
  assert receipt.source_git_sha == GIT_SHA
  assert receipt.tenant_id == "eisenhower-owner"
  assert receipt.project_ids == ("eisenhower",)
  assert receipt.response_users == (USER_ID,)
  assert receipt.models.generator.image_digest == IMAGE_DIGEST
  assert receipt.models.reranker.image_digest == IMAGE_DIGEST
  assert receipt.memory.model_dump() == {"write": False, "retrieval": False, "response": False}
  assert receipt.mag_mode == "disabled"
  assert receipt.public_release_authorized is False
  assert receipt.rollback.primary_project == "eisenhower-e2eff0"
  assert receipt.canonical_document_count == 24
  assert receipt.projection_point_count == 118


def test_receipt_binds_one_explicit_runtime_owner_uuid_without_a_source_hardcode(tmp_path):
  receipt = build_private_rag_activation(
    _inputs(tmp_path, approval_updates={"response_users": [ALTERNATE_USER_ID]}),
    now=NOW,
  )

  assert receipt.response_users == (ALTERNATE_USER_ID,)
  verifier = (Path(__file__).parents[2] / "deploy/generic/verify-private-rag.sh").read_text()
  assert USER_ID not in verifier
  assert ".response_users | length == 1" in verifier
  assert "jq -er '.response_users[0]'" in verifier


def test_receipt_rejects_manifest_drift_and_dirty_git(tmp_path):
  inputs = _inputs(tmp_path)
  inputs.corpus_manifest.write_text("drift\n", encoding="utf-8")
  with pytest.raises(ActivationBlocked, match="corpus manifest"):
    build_private_rag_activation(inputs, now=NOW)

  dirty_inputs = _inputs(tmp_path / "dirty", git_dirty=True)
  with pytest.raises(ActivationBlocked, match="clean Git"):
    build_private_rag_activation(dirty_inputs, now=NOW)


@pytest.mark.parametrize(
  ("updates", "message"),
  [
    ({"valid_until": NOW.isoformat()}, "expired"),
    ({"valid_until": (NOW + timedelta(days=31)).isoformat()}, "thirty days"),
    ({"tenant_id": "other"}, "tenant"),
    ({"project_ids": ["other"]}, "project"),
    ({"response_users": ["other"]}, "response_users"),
    ({"response_users": []}, "response_users"),
    ({"response_users": [USER_ID, ALTERNATE_USER_ID]}, "response_users"),
    ({"memory": {"write": True, "retrieval": False, "response": False}}, "memory"),
    ({"mag_mode": "canary"}, "mag_mode"),
    ({"public_release_authorized": True}, "public_release_authorized"),
  ],
)
def test_receipt_rejects_scope_expiry_or_forbidden_capabilities(tmp_path, updates, message):
  with pytest.raises(ActivationBlocked, match=message):
    build_private_rag_activation(
      _inputs(tmp_path, approval_updates=updates),
      now=NOW,
    )


def test_receipt_requires_exact_model_digest_and_bounded_stop_thresholds(tmp_path):
  inputs = _inputs(tmp_path)
  payload = json.loads(inputs.approval.read_text(encoding="utf-8"))
  payload["models"]["generator"]["image_digest"] = "mutable:latest"
  inputs.approval.write_text(json.dumps(payload), encoding="utf-8")
  with pytest.raises(ActivationBlocked, match="image_digest"):
    build_private_rag_activation(inputs, now=NOW)

  threshold_inputs = _inputs(
    tmp_path / "thresholds",
    approval_updates={"stop_thresholds": {"maximum_p95_seconds": 15.0}},
  )
  with pytest.raises(ActivationBlocked, match="stop_thresholds"):
    build_private_rag_activation(threshold_inputs, now=NOW)


def test_private_receipt_and_public_commitment_are_immutable_and_minimal(tmp_path):
  receipt = build_private_rag_activation(_inputs(tmp_path), now=NOW)
  private_path = tmp_path / "private" / "activation.json"
  commitment_path = tmp_path / "public" / "activation-commitment.json"

  write_private_rag_activation(receipt, private_path, commitment_path)

  private_bytes = private_path.read_bytes()
  commitment = json.loads(commitment_path.read_text(encoding="utf-8"))
  assert private_path.stat().st_mode & 0o777 == 0o600
  assert commitment_path.stat().st_mode & 0o777 == 0o600
  assert commitment == {
    "schema_version": "private-rag-activation-commitment-v1",
    "source_git_sha": GIT_SHA,
    "receipt_sha256": sha256(private_bytes).hexdigest(),
  }
  assert USER_ID.encode() in private_bytes
  assert USER_ID not in commitment_path.read_text(encoding="utf-8")

  with pytest.raises(ActivationBlocked, match="already exists"):
    write_private_rag_activation(receipt, private_path, commitment_path)


def test_cli_writes_final_sha_receipt_and_commitment_without_echoing_private_fields(tmp_path):
  inputs = _inputs(tmp_path)
  private_path = tmp_path / "evidence" / "activation.json"
  commitment_path = tmp_path / "evidence" / "activation-commitment.json"
  script = Path(__file__).parents[1] / "scripts" / "build_private_rag_activation.py"

  result = subprocess.run(
    [
      sys.executable,
      str(script),
      "--approval", str(inputs.approval),
      "--corpus-manifest", str(inputs.corpus_manifest),
      "--corpus-snapshot", str(inputs.corpus_snapshot),
      "--ragops-report", str(inputs.ragops_report),
      "--answer-report", str(inputs.answer_report),
      "--source-git-sha", inputs.source_git_sha,
      "--now", NOW.isoformat(),
      "--output", str(private_path),
      "--commitment", str(commitment_path),
    ],
    cwd=Path(__file__).parents[1],
    text=True,
    capture_output=True,
  )

  assert result.returncode == 0, result.stderr
  assert json.loads(private_path.read_text(encoding="utf-8"))["source_git_sha"] == GIT_SHA
  assert json.loads(commitment_path.read_text(encoding="utf-8"))["source_git_sha"] == GIT_SHA
  assert USER_ID not in result.stdout
  assert result.stdout.strip() == commitment_path.as_posix()
