#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.artifacts.registry import ImmutableArtifactRegistry
from app.ops.candidates import CandidateWorkflowError, register_ragops_candidate


def main() -> int:
  parser = argparse.ArgumentParser(description="Register a verified candidate-only RAGOps run.")
  parser.add_argument("--registry", type=Path, required=True)
  parser.add_argument("--candidate-id", required=True)
  parser.add_argument("--git-sha", required=True)
  parser.add_argument("--git-dirty", action="store_true")
  parser.add_argument("--corpus-manifest", type=Path, required=True)
  parser.add_argument("--golden", type=Path, required=True)
  parser.add_argument("--snapshot", type=Path, required=True)
  parser.add_argument("--report", type=Path, required=True)
  try:
    args = parser.parse_args()
    manifest = register_ragops_candidate(
      registry=ImmutableArtifactRegistry(args.registry),
      candidate_id=args.candidate_id,
      git_sha=args.git_sha,
      git_dirty=args.git_dirty,
      corpus_manifest_path=args.corpus_manifest,
      golden_path=args.golden,
      snapshot_path=args.snapshot,
      report=json.loads(args.report.read_text(encoding="utf-8")),
    )
    print(manifest.model_dump_json())
    return 0
  except (CandidateWorkflowError, OSError, ValueError, json.JSONDecodeError) as issue:
    print(f"ragops-candidate-blocked: {issue}", file=sys.stderr)
    return 2


if __name__ == "__main__":
  raise SystemExit(main())
