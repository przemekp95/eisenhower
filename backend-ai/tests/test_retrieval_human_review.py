from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

import pytest

from app.rag.human_review import (
  HUMAN_ATTESTED_DATASET_VERSION,
  build_review_template,
  finalize_human_review,
)


ATTESTATION = (
  "I independently reviewed every case against the frozen sources and approve this record."
)


def _write_json(path: Path, value) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _review_workspace(tmp_path: Path) -> dict[str, Path | dict]:
  root = tmp_path / "repo"
  sources = {
    "docs/source.md": "Approved source.\n",
    "docs/secret.md": "Tenant-scoped source.\n",
  }
  for relative, text in sources.items():
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")

  records = []
  total_bytes = 0
  for relative in sorted(sources):
    raw = (root / relative).read_bytes()
    records.append(f"{sha256(raw).hexdigest()}  {relative}\n")
    total_bytes += len(raw)
  snapshot_sha = sha256("".join(records).encode()).hexdigest()
  manifest = {
    "manifest_version": "test-corpus-v1",
    "initial_snapshot": {
      "algorithm": "sha256-file-list-v1",
      "sha256": snapshot_sha,
      "document_count": 2,
      "total_bytes": total_bytes,
      "documents": sorted(sources),
    },
    "document_policy": {"maximum_document_bytes": 1000, "maximum_documents": 10},
    "identity_and_acl": {
      "initial_tenant": "tenant-a",
      "cross_tenant_access": False,
      "request_payload_may_expand_scope": False,
    },
    "incremental_sources": [],
  }
  manifest_path = root / "docs/ai-rebuild/corpus-manifest-v1.json"
  _write_json(manifest_path, manifest)

  source_id = sha256("docs/source.md".encode()).hexdigest()
  secret_id = sha256("docs/secret.md".encode()).hexdigest()
  source_checksum = sha256("Approved source.".encode()).hexdigest()
  cases = [
    {
      "dataset_version": "review-candidate-unapproved",
      "case_id": "answerable",
      "tenant_id": "tenant-a",
      "user_id": "review-user",
      "project_ids": ["project-a"],
      "query_project_id": "project-a",
      "roles": [],
      "language": "en",
      "split": "dev",
      "task": "What is approved?",
      "corpus_version": "test-corpus-v1",
      "index_version": "index-v1",
      "answerability": "answerable",
      "relevant_document_ids": [source_id],
      "expected_content_versions": {
        source_id: f"test-corpus-v1:{source_checksum}",
      },
      "allowed_citation_ids": [f"{source_id}#0"],
      "tags": ["quality"],
    },
    {
      "dataset_version": "review-candidate-unapproved",
      "case_id": "isolation",
      "tenant_id": "tenant-a",
      "user_id": "review-user",
      "project_ids": ["project-a"],
      "query_project_id": "project-a",
      "roles": [],
      "language": "pl",
      "split": "holdout",
      "task": "Pokaż obcy dokument.",
      "corpus_version": "test-corpus-v1",
      "index_version": "index-v1",
      "answerability": "no_answer",
      "forbidden_document_ids": [secret_id],
      "forbidden_citation_ids": [f"{secret_id}#0"],
      "tags": ["isolation"],
    },
  ]
  candidate_path = root / "backend-ai/evaluation/retrieval-v1/candidate.jsonl"
  candidate_path.parent.mkdir(parents=True, exist_ok=True)
  candidate_path.write_text(
    "".join(json.dumps(case, sort_keys=True, separators=(",", ":")) + "\n" for case in cases),
    encoding="utf-8",
  )
  thresholds = {
    "dataset_version": "review-candidate-unapproved",
    "approval_status": "human_review_required",
    "k": 5,
    "global": {
      "recall_at_k_min": 0.9,
      "mrr_at_k_min": 0.8,
      "no_hit_accuracy_min": 1.0,
      "duplicate_hit_rate_max": 0.02,
      "freshness_rate_min": 1.0,
      "stale_hit_rate_max": 0.0,
      "forbidden_hit_rate_max": 0.0,
      "isolation_violation_rate_max": 0.0,
    },
    "required_slices": {
      "language_pl": {"recall_at_k_min": 0.8, "mrr_at_k_min": 0.7},
      "language_en": {"recall_at_k_min": 0.8, "mrr_at_k_min": 0.7},
      "split_holdout": {
        "recall_at_k_min": 0.8,
        "mrr_at_k_min": 0.7,
        "no_hit_accuracy_min": 1.0,
      },
    },
    "latency_observation": {
      "metric": "warm_local_p95_ms",
      "proposed_max": 250,
      "acceptance_scope": "local_reference_hardware_only",
    },
    "notes": ["Human review required."],
  }
  thresholds_path = candidate_path.with_name("thresholds.json")
  _write_json(thresholds_path, thresholds)
  review_path = candidate_path.with_name("human-review.json")
  return {
    "root": root,
    "candidate": candidate_path,
    "thresholds": thresholds_path,
    "manifest": manifest_path,
    "review": review_path,
    "cases": cases,
  }


def _complete_review(workspace: dict[str, Path | dict]) -> dict:
  review = build_review_template(
    workspace["candidate"], workspace["thresholds"], workspace["manifest"]
  )
  review.update(
    {
      "reviewer_id": "independent-human-1",
      "completed_at": "2026-08-11T12:00:00+00:00",
      "independent_human_review": True,
      "no_private_data_exposed": True,
      "labels_decision": "APPROVED",
      "thresholds_decision": "APPROVED",
      "reviewer_attestation": ATTESTATION,
    }
  )
  for decision in review["decisions"]:
    decision["outcome"] = "APPROVED"
  return review


def _finalize(workspace: dict[str, Path | dict], review: dict):
  _write_json(workspace["review"], review)
  return finalize_human_review(
    workspace["candidate"],
    workspace["thresholds"],
    workspace["manifest"],
    workspace["review"],
  )


def test_template_is_hash_bound_and_pending_review_fails_closed(tmp_path):
  workspace = _review_workspace(tmp_path)
  review = build_review_template(
    workspace["candidate"], workspace["thresholds"], workspace["manifest"]
  )

  assert review["candidate_sha256"] == sha256(workspace["candidate"].read_bytes()).hexdigest()
  assert [item["outcome"] for item in review["decisions"]] == ["PENDING", "PENDING"]
  with pytest.raises(ValueError, match="still contains PENDING"):
    _finalize(workspace, review)


def test_complete_review_freezes_dataset_and_approval_manifest(tmp_path):
  workspace = _review_workspace(tmp_path)
  frozen, approval = _finalize(workspace, _complete_review(workspace))

  assert {case.dataset_version for case in frozen} == {HUMAN_ATTESTED_DATASET_VERSION}
  assert approval["approval_status"] == "human_attestation_recorded_frozen"
  assert approval["provenance_status"] == "self_attested_not_cryptographically_verified"
  assert approval["task_gate_status"] == "requires_out_of_band_human_provenance_confirmation"
  assert approval["case_count"] == 2
  assert approval["case_counts"] == {"dev_en": 1, "holdout_pl": 1}
  assert approval["correction_count"] == 0


@pytest.mark.parametrize("drift_target", ["candidate", "thresholds", "manifest"])
def test_bound_input_hash_drift_is_rejected(tmp_path, drift_target):
  workspace = _review_workspace(tmp_path)
  review = _complete_review(workspace)
  workspace[drift_target].write_text(
    workspace[drift_target].read_text(encoding="utf-8") + "\n", encoding="utf-8"
  )

  with pytest.raises(ValueError, match="input hash drift"):
    _finalize(workspace, review)


def test_physical_corpus_drift_is_rejected_even_when_manifest_is_unchanged(tmp_path):
  workspace = _review_workspace(tmp_path)
  review = _complete_review(workspace)
  (workspace["root"] / "docs/source.md").write_text("Drifted source.\n", encoding="utf-8")

  with pytest.raises(ValueError, match="snapshot does not match"):
    _finalize(workspace, review)


def test_finalize_reads_each_bound_input_once(tmp_path, monkeypatch):
  workspace = _review_workspace(tmp_path)
  review = _complete_review(workspace)
  _write_json(workspace["review"], review)
  bound_paths = {
    workspace["candidate"],
    workspace["thresholds"],
    workspace["manifest"],
    workspace["review"],
  }
  counts = {path: 0 for path in bound_paths}
  original = Path.read_bytes

  def counted_read(path):
    if path in counts:
      counts[path] += 1
    return original(path)

  monkeypatch.setattr(Path, "read_bytes", counted_read)
  finalize_human_review(
    workspace["candidate"],
    workspace["thresholds"],
    workspace["manifest"],
    workspace["review"],
  )

  assert counts == {path: 1 for path in bound_paths}


def test_correction_cannot_change_scope_or_reference_unknown_document(tmp_path):
  workspace = _review_workspace(tmp_path)
  review = _complete_review(workspace)
  correction = deepcopy(workspace["cases"][0])
  correction["tenant_id"] = "tenant-b"
  review["decisions"][0] = {
    "case_id": "answerable",
    "outcome": "CORRECTED",
    "correction": correction,
  }
  review["labels_decision"] = "CORRECTED"
  with pytest.raises(ValueError, match="protected field tenant_id"):
    _finalize(workspace, review)

  correction["tenant_id"] = "tenant-a"
  correction["relevant_document_ids"] = ["f" * 64]
  correction["expected_content_versions"] = {"f" * 64: "test-corpus-v1:" + "e" * 64}
  review["decisions"][0]["correction"] = correction
  with pytest.raises(ValueError, match="outside the frozen corpus"):
    _finalize(workspace, review)


def test_predeclared_no_answer_security_probe_cannot_be_made_answerable(tmp_path):
  workspace = _review_workspace(tmp_path)
  review = _complete_review(workspace)
  correction = deepcopy(workspace["cases"][1])
  correction["answerability"] = "answerable"
  review["decisions"][1] = {
    "case_id": "isolation",
    "outcome": "CORRECTED",
    "correction": correction,
  }
  review["labels_decision"] = "CORRECTED"

  with pytest.raises(ValueError, match="security probe cannot become answerable"):
    _finalize(workspace, review)


@pytest.mark.parametrize(
  ("mutate", "message"),
  [
    (
      lambda thresholds: thresholds["global"].__setitem__("isolation_violation_rate_max", 0.1),
      "zero-tolerance threshold",
    ),
    (
      lambda thresholds: thresholds["latency_observation"].__setitem__("metric", "other"),
      "threshold metadata",
    ),
    (lambda thresholds: thresholds.__setitem__("k", 10), "changing k"),
  ],
)
def test_security_and_measurement_threshold_contract_cannot_be_relaxed(tmp_path, mutate, message):
  workspace = _review_workspace(tmp_path)
  review = _complete_review(workspace)
  mutate(review["final_thresholds"])
  review["thresholds_decision"] = "CORRECTED"

  with pytest.raises(ValueError, match=message):
    _finalize(workspace, review)


def test_threshold_decision_must_match_actual_changes(tmp_path):
  workspace = _review_workspace(tmp_path)
  review = _complete_review(workspace)
  review["final_thresholds"]["global"]["recall_at_k_min"] = 0.91
  with pytest.raises(ValueError, match="thresholds_decision must match"):
    _finalize(workspace, review)

  review = _complete_review(workspace)
  review["thresholds_decision"] = "CORRECTED"
  with pytest.raises(ValueError, match="thresholds_decision must match"):
    _finalize(workspace, review)


def test_review_completion_timestamp_must_be_utc(tmp_path):
  workspace = _review_workspace(tmp_path)
  review = _complete_review(workspace)
  review["completed_at"] = "2026-08-11T14:00:00+02:00"

  with pytest.raises(ValueError, match="completed_at must use UTC"):
    _finalize(workspace, review)


def test_cli_refuses_to_overwrite_review_or_frozen_outputs(tmp_path):
  workspace = _review_workspace(tmp_path)
  _write_json(workspace["review"], _complete_review(workspace))
  script = Path(__file__).parents[1] / "scripts/finalize_retrieval_review.py"
  dataset = workspace["review"].with_name("approved.jsonl")
  manifest = workspace["review"].with_name("approval.json")
  command = [
    sys.executable,
    str(script),
    "--candidate",
    str(workspace["candidate"]),
    "--thresholds",
    str(workspace["thresholds"]),
    "--corpus-manifest",
    str(workspace["manifest"]),
    "--review",
    str(workspace["review"]),
    "--output-dataset",
    str(dataset),
    "--output-manifest",
    str(manifest),
  ]
  first = subprocess.run(command, check=False, capture_output=True, text=True)
  second = subprocess.run(command, check=False, capture_output=True, text=True)
  initialize = subprocess.run(
    command[:10] + ["--initialize"], check=False, capture_output=True, text=True
  )

  assert first.returncode == 0, first.stderr
  assert second.returncode == 2
  assert "refusing to overwrite evidence" in second.stderr
  assert initialize.returncode == 2
  assert "refusing to overwrite human work" in initialize.stderr

  manifest.unlink()
  recovered = subprocess.run(command, check=False, capture_output=True, text=True)
  assert recovered.returncode == 0, recovered.stderr
  assert manifest.exists()
