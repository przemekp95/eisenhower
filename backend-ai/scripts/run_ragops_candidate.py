#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = PROJECT_ROOT.parent
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.artifacts.registry import (
  ImmutableArtifactRegistry,
  write_private_bytes,
  write_public_commitment,
)
from app.ops.candidates import register_ragops_candidate
from scripts.run_retrieval_candidate import run as run_retrieval


def main() -> int:
  parser = argparse.ArgumentParser(description="Run a live-dependency, candidate-only RAGOps pipeline.")
  parser.add_argument("--registry", type=Path, required=True)
  parser.add_argument("--candidate-id", required=True)
  parser.add_argument("--git-sha", required=True)
  parser.add_argument("--git-dirty", action="store_true")
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument(
    "--mongo-uri",
    required=True,
    help="Explicit isolated candidate MongoDB URI.",
  )
  parser.add_argument(
    "--qdrant-url",
    required=True,
    help="Explicit isolated candidate Qdrant base URL.",
  )
  parser.add_argument(
    "--golden", type=Path,
    default=PROJECT_ROOT / "evaluation" / "retrieval-v1" / "review-candidate-v1.jsonl",
  )
  args = parser.parse_args()
  snapshot_path = args.output.parent / "qdrant-candidate.snapshot"
  retrieval = run_retrieval(
    args.golden,
    snapshot_output=snapshot_path,
    mongo_uri=args.mongo_uri,
    qdrant_url=args.qdrant_url,
  )
  recovery = retrieval["snapshot_restore"]
  report = {
    "canonical_before_vector": True,
    "ingestion": {
      "documents": retrieval["ingestion"]["accepted"],
      "failed": retrieval["ingestion"]["pending"],
    },
    "reconciliation": {
      "missing": retrieval["reconciliation"]["pending"],
      "stale": retrieval["reconciliation"]["drifted"],
      "orphan": retrieval["reconciliation"]["projected"],
    },
    "evaluation": retrieval["evaluation"],
    "snapshot_restore": {
      "verified": recovery["matches_source"],
      "checksum_match": (
        recovery["qdrant_checksum"] == recovery["independent_download_sha256"]
      ),
      "isolated": recovery["isolated_restore"],
      "source_collection": recovery["source_collection"],
      "restored_collection": recovery["restored_collection"],
      "source_digest_sha256": recovery["source_digest_sha256"],
      "restored_digest_sha256": recovery["restored_digest_sha256"],
    },
    "collection": {
      "name": retrieval["collection"]["name"],
      "revision": retrieval["model"]["embedding_version"],
    },
    "runtime": {
      "qdrant_version": retrieval["runtime"]["qdrant_server_version"],
      "mongo_version": retrieval["runtime"]["pymongo_version"],
    },
    "alias_promoted": False,
    "cleanup": {"retrieval": retrieval["cleanup"]},
    "representative_human_gate": {"passed": False, "reason": "TASK-013 pending"},
  }
  manifest = register_ragops_candidate(
    registry=ImmutableArtifactRegistry(args.registry),
    candidate_id=args.candidate_id,
    git_sha=args.git_sha,
    git_dirty=args.git_dirty,
    corpus_manifest_path=REPOSITORY_ROOT / "docs" / "ai-rebuild" / "corpus-manifest-v1.json",
    golden_path=args.golden,
    snapshot_path=snapshot_path,
    report=report,
  )
  write_private_bytes(args.output, (manifest.model_dump_json(indent=2) + "\n").encode())
  write_public_commitment(manifest, args.output.with_name("ragops-commitment.json"))
  print(json.dumps({"candidate_id": manifest.candidate_id, "manifest_checksum": manifest.manifest_checksum}))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
