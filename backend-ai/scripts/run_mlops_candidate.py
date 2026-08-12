#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from benchmark_classifier import run_benchmark

from app.artifacts.registry import (
  ImmutableArtifactRegistry,
  write_private_bytes,
  write_public_commitment,
)
from app.config import load_settings
from app.local_model import LocalMiniLMClassifier
from app.ops.candidates import CandidateWorkflowError, register_mlops_candidate


def main() -> int:
  parser = argparse.ArgumentParser(description="Create an immutable candidate-only MLOps artifact.")
  parser.add_argument("--registry", type=Path, required=True)
  parser.add_argument("--candidate-id", required=True)
  parser.add_argument("--git-sha", required=True)
  parser.add_argument("--git-dirty", action="store_true")
  parser.add_argument("--output", type=Path, required=True)
  args = parser.parse_args()
  try:
    settings = load_settings()
    if settings.evaluation_data_path is None:
      raise CandidateWorkflowError("evaluation dataset path is missing")
    report = run_benchmark()
    manifest = register_mlops_candidate(
      registry=ImmutableArtifactRegistry(args.registry),
      candidate_id=args.candidate_id,
      git_sha=args.git_sha,
      git_dirty=args.git_dirty,
      training_path=settings.training_data_path,
      evaluation_path=settings.evaluation_data_path,
      report=report,
      current_pointer_path=LocalMiniLMClassifier(settings).current_pointer_path,
    )
    write_private_bytes(args.output, (manifest.model_dump_json(indent=2) + "\n").encode())
    write_public_commitment(manifest, args.output.with_name("mlops-commitment.json"))
    print(json.dumps({"candidate_id": manifest.candidate_id, "manifest_checksum": manifest.manifest_checksum}))
    return 0
  except (CandidateWorkflowError, OSError, ValueError) as issue:
    print(f"mlops-candidate-blocked: {issue}", file=sys.stderr)
    return 2


if __name__ == "__main__":
  raise SystemExit(main())
