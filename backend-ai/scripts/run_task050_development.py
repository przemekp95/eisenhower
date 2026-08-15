#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from scripts.run_task049_calibration import REPOSITORY_ROOT, run_calibration
from app.rag.task049_evaluation import (
  build_task050_candidates,
  generate_task050_development_dataset,
)


def main() -> int:
  parser = argparse.ArgumentParser(
    description="Run the exact-SHA TASK-050 development-only confidence candidate."
  )
  parser.add_argument("--seed-file", type=Path, required=True)
  parser.add_argument("--policy", type=Path, required=True)
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--repository-root", type=Path, default=REPOSITORY_ROOT)
  parser.add_argument("--mongo-uri", default="mongodb://127.0.0.1:27017/?directConnection=true")
  parser.add_argument("--qdrant-url", default="http://127.0.0.1:6333")
  parser.add_argument("--model-name", default="BAAI/bge-m3")
  parser.add_argument("--model-revision", default="5617a9f61b028005a4858fdac845db406aefb181")
  parser.add_argument("--device", default="cuda")
  args = parser.parse_args()
  run_calibration(
    repository_root=args.repository_root.resolve(),
    seed_path=args.seed_file.resolve(),
    policy_path=args.policy.resolve(),
    output_path=args.output.resolve(),
    mongo_uri=args.mongo_uri,
    qdrant_url=args.qdrant_url,
    model_name=args.model_name,
    model_revision=args.model_revision,
    device=args.device,
    dataset_factory=generate_task050_development_dataset,
    candidate_factory=build_task050_candidates,
    seed_commitment_field="development_seed_sha256",
    schema_version="task050-development-v1",
    evidence_scope="synthetic_local_physical_development_only",
  )
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
