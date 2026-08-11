#!/usr/bin/env python3
from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import platform
import subprocess
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.ci_impact.artifacts import CiImpactRegistry
from app.ci_impact.classifier import MultilabelLogisticModel
from app.ci_impact.features import FeatureExtractor, LocalDependencyGraph
from app.ci_impact.models import ChangeSet, JobConfig
from app.ci_impact.shadow import ShadowPlanner
from app.ci_impact.workflow import validate_repository_job_universe


def main() -> int:
  parser = argparse.ArgumentParser(description="Publish a counterfactual CI plan without skipping any real job.")
  parser.add_argument("--changes", type=Path, required=True)
  parser.add_argument("--jobs-config", type=Path, required=True)
  parser.add_argument("--registry", type=Path)
  parser.add_argument("--candidate-id")
  parser.add_argument("--expected-model-checksum")
  parser.add_argument("--repo-root", type=Path, default=PROJECT_ROOT.parent)
  parser.add_argument("--drift-detected", action="store_true")
  parser.add_argument("--output", type=Path, required=True)
  args = parser.parse_args()
  try:
    changes = ChangeSet.model_validate_json(args.changes.read_text(encoding="utf-8"))
    config = JobConfig.model_validate_json(args.jobs_config.read_text(encoding="utf-8"))
    blocking_reasons = list(validate_repository_job_universe(args.repo_root, config))
    model = None
    if bool(args.registry) != bool(args.candidate_id):
      blocking_reasons.append("candidate_lineage_incomplete")
    elif args.registry and args.candidate_id:
      try:
        registry = CiImpactRegistry(args.registry)
        manifest = registry.load_manifest(args.candidate_id)
        model_bytes = (registry.blobs / manifest.model.sha256).read_bytes()
        candidate_model = MultilabelLogisticModel.model_validate_json(model_bytes)
        feature_schema = json.dumps(
          {"schema_version": "ci-impact-features-v1", "feature_names": candidate_model.feature_names},
          sort_keys=True,
          separators=(",", ":"),
        ).encode()
        workflow_bytes = (args.repo_root / ".github/workflows/ci.yml").read_bytes()
        runtime_text = f"python:{platform.python_version()}:{platform.python_implementation()}"
        current_git_sha = subprocess.run(
          ["git", "rev-parse", "HEAD"], cwd=args.repo_root, check=True,
          capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        current_dirty = bool(subprocess.run(
          ["git", "status", "--porcelain"], cwd=args.repo_root, check=True,
          capture_output=True, text=True, timeout=10,
        ).stdout)
        lineage_checks = {
          "candidate_not_promotion_eligible": manifest.promotion_eligible is not True,
          "candidate_git_mismatch": manifest.git_sha != current_git_sha or manifest.git_dirty or current_dirty,
          "dataset_lineage_mismatch": manifest.dataset_sha256 != candidate_model.training_dataset_sha256,
          "feature_schema_mismatch": manifest.feature_schema_sha256 != sha256(feature_schema).hexdigest(),
          "job_config_checksum_mismatch": manifest.job_config_sha256 != config.checksum(),
          "workflow_checksum_mismatch": manifest.workflow_sha256 != sha256(workflow_bytes).hexdigest(),
          "runtime_mismatch": (
            manifest.runtime.version != platform.python_version()
            or manifest.runtime.digest != sha256(runtime_text.encode()).hexdigest()
          ),
        }
        blocking_reasons.extend(reason for reason, failed in lineage_checks.items() if failed)
        if not blocking_reasons:
          model = candidate_model
      except (OSError, subprocess.SubprocessError, ValueError):
        blocking_reasons.append("candidate_lineage_invalid")
    graph = LocalDependencyGraph.from_repository(args.repo_root)
    features = FeatureExtractor(config=config, dependency_graph=graph).extract(changes)
    plan = ShadowPlanner(config=config).plan(
      changes=changes,
      features=features,
      model=model,
      expected_model_checksum=args.expected_model_checksum,
      drift_detected=args.drift_detected,
      blocking_reasons=tuple(dict.fromkeys(blocking_reasons)),
    )
    payload = {
      "plan": plan.model_dump(mode="json"),
      "feature_checksum": features.checksum,
      "job_config_checksum": config.checksum(),
      "authoritative_execution": "full_ci_unchanged",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"abstain": plan.abstain, "full_ci": plan.full_ci, "reasons": plan.reasons}))
    return 0
  except (OSError, ValueError) as issue:
    # Even CLI failure communicates no skip decision and must leave full CI authoritative.
    print(f"ci-impact-shadow-blocked-full-ci: {issue}", file=sys.stderr)
    return 2


if __name__ == "__main__":
  raise SystemExit(main())
