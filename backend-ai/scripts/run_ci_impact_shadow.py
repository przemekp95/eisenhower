#!/usr/bin/env python3
from __future__ import annotations

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import platform
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.ci_impact.artifacts import CiImpactRegistry
from app.ci_impact.classifier import MultilabelLogisticModel
from app.ci_impact.deterministic import (
  resolve_actions_context, resolve_authoritative_plan, verify_deterministic_plan,
)
from app.ci_impact.evaluation import EvaluationReport
from app.ci_impact.features import FeatureExtractor, LocalDependencyGraph
from app.ci_impact.git_changes import changes_between, planner_changes_between
from app.ci_impact.lineage import implementation_checksum
from app.ci_impact.models import DeterministicTargetAdapter, JobConfig, ShadowPlan
from app.ci_impact.promotion import (
  TRUSTED_APPROVAL_VERIFIER_AVAILABLE, CiImpactPromotionEvidence, PromotionPolicy,
)
from app.ci_impact.shadow import ShadowPlanner
from app.ci_impact.workflow import validate_repository_job_universe


def main() -> int:
  parser = argparse.ArgumentParser(description="Publish a counterfactual CI plan without skipping any real job.")
  parser.add_argument("--base-sha", required=True)
  parser.add_argument("--head-sha", required=True)
  parser.add_argument("--jobs-config", type=Path, required=True)
  parser.add_argument("--promotion-policy", type=Path, required=True)
  parser.add_argument("--target-adapter", type=Path, required=True)
  parser.add_argument("--deterministic-plan", type=Path)
  parser.add_argument("--event-name")
  parser.add_argument("--ref-name")
  parser.add_argument("--base-ref-name")
  parser.add_argument("--registry", type=Path)
  parser.add_argument("--candidate-id")
  parser.add_argument("--expected-model-checksum")
  parser.add_argument("--repo-root", type=Path, default=PROJECT_ROOT.parent)
  parser.add_argument("--drift-detected", action="store_true")
  parser.add_argument("--output", type=Path, required=True)
  args = parser.parse_args()
  args.repo_root = args.repo_root.resolve()
  config = None
  try:
    config = JobConfig.model_validate_json(args.jobs_config.read_text(encoding="utf-8"))
    policy = PromotionPolicy.model_validate_json(args.promotion_policy.read_text(encoding="utf-8"))
    target_adapter = DeterministicTargetAdapter.model_validate_json(
      args.target_adapter.read_text(encoding="utf-8")
    )
    target_adapter.jobs_for(tuple(target_adapter.target_to_jobs), config)
    changes = changes_between(args.repo_root, args.base_sha, args.head_sha)
    blocking_reasons = list(validate_repository_job_universe(args.repo_root, config))
    deterministic_jobs = config.deterministic_jobs
    deterministic_plan_verified = False
    if args.deterministic_plan:
      try:
        event_name, ref_name, base_ref_name, context_trusted = resolve_actions_context(
          os.environ,
          requested_event_name=args.event_name,
          requested_ref_name=args.ref_name,
          requested_base_ref_name=args.base_ref_name,
        )
        if not context_trusted:
          blocking_reasons.append("github_actions_context_untrusted")
        deterministic_plan = json.loads(args.deterministic_plan.read_text(encoding="utf-8"))
        authoritative_plan = resolve_authoritative_plan(
          args.repo_root,
          base_sha=changes.base_sha,
          head_sha=changes.head_sha,
          event_name=event_name,
          ref_name=ref_name,
          base_ref_name=base_ref_name,
        )
        deterministic_jobs, deterministic_full_ci = verify_deterministic_plan(
          deterministic_plan,
          expected_base_sha=changes.base_sha,
          expected_head_sha=changes.head_sha,
          expected_changes=planner_changes_between(
            args.repo_root, changes.base_sha, changes.head_sha
          ),
          expected_event_name=event_name,
          expected_ref_name=ref_name,
          expected_base_ref_name=base_ref_name,
          authoritative_plan=authoritative_plan,
          adapter=target_adapter,
          config=config,
        )
        deterministic_plan_verified = context_trusted
        if deterministic_full_ci:
          blocking_reasons.append("deterministic_plan_full_ci")
      except (OSError, TypeError, ValueError):
        blocking_reasons.append("deterministic_plan_invalid")
    else:
      blocking_reasons.append("deterministic_plan_missing")
    model = None
    if bool(args.registry) != bool(args.candidate_id):
      blocking_reasons.append("candidate_lineage_incomplete")
    elif args.registry and args.candidate_id:
      try:
        registry = CiImpactRegistry(args.registry)
        manifest = registry.load_manifest(args.candidate_id)
        model_bytes = (registry.blobs / manifest.model.sha256).read_bytes()
        candidate_model = MultilabelLogisticModel.model_validate_json(model_bytes)
        evidence_payload = json.loads((registry.blobs / manifest.evaluation.sha256).read_text(encoding="utf-8"))
        report = EvaluationReport.model_validate(evidence_payload["evaluation"])
        evidence = CiImpactPromotionEvidence.model_validate(evidence_payload["promotion"])
        report_checksum = sha256(json.dumps(
          report.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
        ).encode()).hexdigest()
        feature_schema = json.dumps(
          {"schema_version": "ci-impact-features-v1", "feature_names": candidate_model.feature_names},
          sort_keys=True,
          separators=(",", ":"),
        ).encode()
        workflow_bytes = (args.repo_root / ".github/workflows/ci.yml").read_bytes()
        runtime_text = f"python:{platform.python_version()}:{platform.python_implementation()}"
        lineage_checks = {
          "candidate_not_promotion_eligible": manifest.promotion_eligible is not True,
          "candidate_training_tree_dirty": manifest.git_dirty,
          "dataset_lineage_mismatch": manifest.dataset_sha256 != candidate_model.training_dataset_sha256,
          "feature_schema_mismatch": manifest.feature_schema_sha256 != sha256(feature_schema).hexdigest(),
          "job_config_checksum_mismatch": manifest.job_config_sha256 != config.checksum(),
          "workflow_checksum_mismatch": manifest.workflow_sha256 != sha256(workflow_bytes).hexdigest(),
          "promotion_policy_checksum_mismatch": (
            manifest.promotion_policy_sha256 != policy.checksum()
            or evidence.promotion_policy_sha256 != policy.checksum()
          ),
          "implementation_checksum_mismatch": (
            manifest.implementation_sha256 != implementation_checksum(PROJECT_ROOT)
          ),
          "deterministic_adapter_checksum_mismatch": (
            manifest.deterministic_adapter_sha256 != target_adapter.checksum()
            or evidence.deterministic_adapter_sha256 != target_adapter.checksum()
          ),
          "promotion_evidence_mismatch": (
            not evidence.passed
            or not evidence.approval_verified
            or evidence.approval_receipt_sha256 is None
            or evidence.dataset_sha256 != manifest.dataset_sha256
            or evidence.model_checksum != candidate_model.checksum
            or evidence.job_config_sha256 != manifest.job_config_sha256
            or evidence.workflow_sha256 != manifest.workflow_sha256
            or evidence.evaluation_checksum != report_checksum
          ),
          "trusted_approval_verifier_unavailable": not TRUSTED_APPROVAL_VERIFIER_AVAILABLE,
          "runtime_mismatch": (
            manifest.runtime.version != platform.python_version()
            or manifest.runtime.digest != sha256(runtime_text.encode()).hexdigest()
          ),
        }
        blocking_reasons.extend(reason for reason, failed in lineage_checks.items() if failed)
        if not blocking_reasons:
          model = candidate_model
      except (KeyError, OSError, TypeError, ValueError):
        blocking_reasons.append("candidate_lineage_invalid")
    graph = LocalDependencyGraph.combine(
      LocalDependencyGraph.from_git_revision(args.repo_root, changes.base_sha),
      LocalDependencyGraph.from_git_revision(args.repo_root, changes.head_sha),
    )
    features = FeatureExtractor(config=config, dependency_graph=graph).extract(changes)
    plan = ShadowPlanner(config=config).plan(
      changes=changes,
      features=features,
      model=model,
      expected_model_checksum=args.expected_model_checksum,
      drift_detected=args.drift_detected,
      blocking_reasons=tuple(dict.fromkeys(blocking_reasons)),
      deterministic_jobs=deterministic_jobs,
      deterministic_plan_verified=deterministic_plan_verified,
    )
    payload = {
      "plan": plan.model_dump(mode="json"),
      "changes": changes.model_dump(mode="json"),
      "feature_checksum": features.checksum,
      "job_config_checksum": config.checksum(),
      "deterministic_adapter_checksum": target_adapter.checksum(),
      "authoritative_execution": "full_ci_unchanged",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"abstain": plan.abstain, "full_ci": plan.full_ci, "reasons": plan.reasons}))
    return 0
  except (OSError, ValueError) as issue:
    print(f"ci-impact-shadow-blocked-full-ci: {issue}", file=sys.stderr)
    if config is not None:
      fallback = ShadowPlan(
        probabilities={},
        canonical_jobs=config.all_jobs,
        deterministic_jobs=config.deterministic_jobs,
        classifier_jobs=(),
        effective_jobs=config.all_jobs,
        abstain=True,
        full_ci=True,
        reasons=("shadow_evaluation_error",),
      )
      args.output.parent.mkdir(parents=True, exist_ok=True)
      args.output.write_text(json.dumps({
        "plan": fallback.model_dump(mode="json"),
        "changes": None,
        "job_config_checksum": config.checksum(),
        "authoritative_execution": "full_ci_unchanged",
      }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
      return 0
    return 2


if __name__ == "__main__":
  raise SystemExit(main())
