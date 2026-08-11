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

from app.artifacts.registry import ImmutableArtifactRegistry
from app.ops.candidates import register_ragops_candidate
from run_retrieval_candidate import run as run_retrieval
from verify_qdrant_recovery import run_verification


def main() -> int:
  parser = argparse.ArgumentParser(description="Run a live-dependency, candidate-only RAGOps pipeline.")
  parser.add_argument("--registry", type=Path, required=True)
  parser.add_argument("--candidate-id", required=True)
  parser.add_argument("--git-sha", required=True)
  parser.add_argument("--git-dirty", action="store_true")
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument(
    "--golden", type=Path,
    default=PROJECT_ROOT / "evaluation" / "retrieval-v1" / "review-candidate-v1.jsonl",
  )
  args = parser.parse_args()
  snapshot_path = args.output.parent / "qdrant-candidate.snapshot"
  retrieval = run_retrieval(args.golden)
  recovery = run_verification(snapshot_path)
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
      "verified": recovery["restore"]["matches_source"],
      "checksum_match": (
        recovery["snapshot"]["qdrant_checksum"]
        == recovery["snapshot"]["independent_download_sha256"]
      ),
      "isolated": recovery["isolation"]["cross_tenant_hits"] == [],
    },
    "collection": {
      "name": recovery["source"]["collection"],
      "revision": retrieval["model"]["embedding_version"],
    },
    "runtime": {
      "qdrant_version": retrieval["runtime"]["qdrant_server_version"],
      "mongo_version": retrieval["runtime"]["pymongo_version"],
    },
    "alias_promoted": False,
    "cleanup": {"retrieval": retrieval["cleanup"], "recovery": recovery["cleanup"]},
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
  args.output.parent.mkdir(parents=True, exist_ok=True)
  args.output.write_text(manifest.model_dump_json(indent=2) + "\n", encoding="utf-8")
  print(json.dumps({"candidate_id": manifest.candidate_id, "manifest_checksum": manifest.manifest_checksum}))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
