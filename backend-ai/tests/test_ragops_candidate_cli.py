from pathlib import Path
import subprocess
import sys

from scripts.run_ragops_candidate import build_ragops_report
from scripts.run_retrieval_candidate import (
  RAGOPS_EMBEDDING_MODEL,
  RAGOPS_EMBEDDING_REVISION,
  RAGOPS_EMBEDDING_VERSION,
  selected_candidate_evaluation,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPOSITORY_ROOT / "backend-ai/scripts/run_ragops_candidate.py"


def test_ragops_candidate_requires_explicit_store_endpoints(tmp_path):
  completed = subprocess.run(
    [
      sys.executable,
      str(SCRIPT),
      "--registry", str(tmp_path / "registry"),
      "--candidate-id", "task065-test",
      "--git-sha", "a" * 40,
      "--output", str(tmp_path / "report.json"),
    ],
    cwd=REPOSITORY_ROOT,
    text=True,
    capture_output=True,
    check=False,
  )

  assert completed.returncode == 2
  assert "--mongo-uri" in completed.stderr
  assert "--qdrant-url" in completed.stderr


def test_ragops_cli_can_use_the_pinned_private_reranker_runtime():
  completed = subprocess.run(
    [sys.executable, str(SCRIPT), "--help"],
    cwd=REPOSITORY_ROOT,
    text=True,
    capture_output=True,
    check=True,
  )

  assert "--reranker-url" in completed.stdout
  assert "EISENHOWER_RERANKER_API_KEY" in completed.stdout


def test_ragops_report_maps_runtime_dataset_version_to_registry_contract():
  retrieval = {
    "ingestion": {"accepted": 19, "pending": 0},
    "reconciliation": {"pending": 0, "drifted": 0, "projected": 0},
    "evaluation": {
      "dataset_version": "retrieval-review-candidate-v4-unapproved",
      "mode": "retrieval_only",
      "metrics": {"recall_at_k": 0.9},
      "cases": [{"case_id": "one"}],
    },
    "snapshot_restore": {
      "matches_source": True,
      "qdrant_checksum": "a" * 64,
      "independent_download_sha256": "a" * 64,
      "isolated_restore": True,
      "source_collection": "candidate",
      "restored_collection": "candidate_restore",
      "source_digest_sha256": "b" * 64,
      "restored_digest_sha256": "b" * 64,
    },
    "collection": {"name": "candidate"},
    "model": {"embedding_version": "minilm-v1"},
    "runtime": {"qdrant_server_version": "1.12.0", "pymongo_version": "4.0"},
    "cleanup": {"mongo_database_dropped": True, "qdrant_collection_deleted": True},
    "idempotency": {
      "second_ingestion": {"duplicate": 19, "projected": 0, "pending": 0},
      "canonical_documents_before": 19,
      "canonical_documents_after": 19,
      "projection_points_before": 640,
      "projection_points_after": 640,
    },
  }

  report = build_ragops_report(retrieval)

  assert report["evaluation"]["dataset"] == (
    "retrieval-review-candidate-v4-unapproved"
  )
  assert report["evaluation"]["metrics"] == {"recall_at_k": 0.9}
  assert report["idempotency"]["second_ingestion"]["duplicate"] == 19


def test_ragops_evaluation_uses_selected_hybrid_not_dense_baseline():
  comparison = {
    "strategies": {
      "dense": {"dataset_version": "v4", "metrics": {"recall_at_k": 0.5}},
      "hybrid": {"dataset_version": "v4", "metrics": {"recall_at_k": 0.9}},
    }
  }

  assert selected_candidate_evaluation(comparison) == comparison["strategies"]["hybrid"]


def test_ragops_uses_the_exact_production_bge_embedding_revision():
  compose = (REPOSITORY_ROOT / "compose.yaml").read_text(encoding="utf-8")

  assert RAGOPS_EMBEDDING_MODEL == "BAAI/bge-m3"
  assert RAGOPS_EMBEDDING_REVISION == "5617a9f61b028005a4858fdac845db406aefb181"
  assert RAGOPS_EMBEDDING_VERSION == "bge-m3-v1"
  assert f"RAG_EMBEDDING_MODEL_NAME={RAGOPS_EMBEDDING_MODEL}" in compose
  assert f"RAG_EMBEDDING_MODEL_REVISION={RAGOPS_EMBEDDING_REVISION}" in compose
  assert f"EMBEDDING_VERSION={RAGOPS_EMBEDDING_VERSION}" in compose
