#!/usr/bin/env python3
from __future__ import annotations

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.ci_impact.artifacts import (
  CiImpactCandidateManifest,
  CiImpactRegistry,
  CiImpactRuntimeLineage,
)
from app.ci_impact.baseline import RuleBaseline
from app.ci_impact.classifier import MultilabelLogisticModel
from app.ci_impact.evaluation import EvaluationCase, evaluate, temporal_holdout
from app.ci_impact.features import FeatureExtractor, LocalDependencyGraph
from app.ci_impact.history import read_dataset
from app.ci_impact.lineage import implementation_checksum
from app.ci_impact.models import DeterministicTargetAdapter, JobConfig
from app.ci_impact.promotion import PromotionPolicy, build_promotion_evidence
from app.ci_impact.shadow import ShadowPlanner
from app.ci_impact.training import build_training_examples, classify_epochs, require_reviewed_training_labels
from app.ci_impact.workflow import validate_repository_job_universe


def _write_once(path: Path, payload: bytes) -> None:
  path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
  try:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
  except FileExistsError as issue:
    if path.read_bytes() != payload:
      raise ValueError(f"immutable output conflict: {path}") from issue
    return
  try:
    remaining = memoryview(payload)
    while remaining:
      written = os.write(descriptor, remaining)
      if written <= 0:
        raise OSError("immutable candidate output write made no progress")
      remaining = remaining[written:]
    os.fsync(descriptor)
  finally:
    os.close(descriptor)


def main() -> int:
  parser = argparse.ArgumentParser(description="Train and register a candidate-only CI impact model.")
  parser.add_argument("--dataset", type=Path, required=True)
  parser.add_argument("--jobs-config", type=Path, required=True)
  parser.add_argument("--promotion-policy", type=Path, required=True)
  parser.add_argument("--target-adapter", type=Path, required=True)
  parser.add_argument("--repo-root", type=Path, default=PROJECT_ROOT.parent)
  parser.add_argument("--registry", type=Path, required=True)
  parser.add_argument("--model-cache", type=Path, required=True)
  parser.add_argument("--output", type=Path, required=True)
  parser.add_argument("--candidate-id", required=True)
  parser.add_argument("--holdout-fraction", type=float, default=0.3)
  args = parser.parse_args()
  try:
    dataset_bytes = args.dataset.read_bytes()
    dataset_sha = sha256(dataset_bytes).hexdigest()
    records = read_dataset(args.dataset)
    config = JobConfig.model_validate_json(args.jobs_config.read_text(encoding="utf-8"))
    universe_reasons = validate_repository_job_universe(args.repo_root, config)
    if universe_reasons:
      raise ValueError("canonical CI job universe drift: " + ", ".join(universe_reasons))
    policy = PromotionPolicy.model_validate_json(args.promotion_policy.read_text(encoding="utf-8"))
    target_adapter = DeterministicTargetAdapter.model_validate_json(
      args.target_adapter.read_text(encoding="utf-8")
    )
    target_adapter.jobs_for(tuple(target_adapter.target_to_jobs), config)
    git_sha = subprocess.run(
      ["git", "rev-parse", "HEAD"], cwd=args.repo_root, check=True,
      capture_output=True, text=True, timeout=10,
    ).stdout.strip()
    git_dirty = bool(subprocess.run(
      ["git", "status", "--porcelain"], cwd=args.repo_root, check=True,
      capture_output=True, text=True, timeout=10,
    ).stdout)
    train_records, holdout_records = temporal_holdout(records, holdout_fraction=args.holdout_fraction)
    require_reviewed_training_labels(train_records, config.classifier_jobs)
    require_reviewed_training_labels(holdout_records, config.classifier_jobs)

    graph_cache: dict[str, LocalDependencyGraph] = {}
    def vector_for(record):
      for revision in (record.changes.base_sha, record.changes.head_sha):
        graph_cache.setdefault(revision, LocalDependencyGraph.from_git_revision(args.repo_root, revision))
      graph = LocalDependencyGraph.combine(
        graph_cache[record.changes.base_sha], graph_cache[record.changes.head_sha]
      )
      return FeatureExtractor(config=config, dependency_graph=graph).extract(
        record.changes
      )

    train_vectors = tuple((record, vector_for(record)) for record in train_records)
    training_examples = build_training_examples(train_vectors, config.classifier_jobs)
    seeds = (7, 19, 31, 43, 59)
    models = tuple(
      MultilabelLogisticModel.train(
        examples=training_examples,
        job_ids=config.classifier_jobs,
        dataset_sha256=dataset_sha,
        training_seed=seed,
      )
      for seed in seeds
    )
    model = models[0]
    cases: list[EvaluationCase] = []
    baseline_cases: list[EvaluationCase] = []
    stability_cases: list[EvaluationCase] = []
    for record in holdout_records:
      features = vector_for(record)
      epochs = classify_epochs(record.changes, features)
      model_plan = ShadowPlanner(config=config).plan(
        changes=record.changes,
        features=features,
        model=model,
        expected_model_checksum=model.checksum,
        deterministic_plan_verified=True,
      )
      baseline_plan = RuleBaseline(config).plan(changes=record.changes, features=features)
      labels = {job: record.labels[job].value for job in config.classifier_jobs}
      common = {
        "epoch": epochs[0],
        "additional_epochs": epochs[1:],
        "labels": labels,
        "change_fingerprint": features.checksum,
      }
      cases.append(EvaluationCase(
        probabilities={job: model_plan.probabilities.get(job, 1.0) for job in config.classifier_jobs},
        selected_jobs=model_plan.classifier_jobs,
        abstain=model_plan.abstain,
        stability_variant=f"seed-{model.training_seed}",
        **common,
      ))
      for variant_model in models:
        variant_plan = ShadowPlanner(config=config).plan(
          changes=record.changes,
          features=features,
          model=variant_model,
          expected_model_checksum=variant_model.checksum,
          deterministic_plan_verified=True,
        )
        stability_cases.append(EvaluationCase(
          probabilities={job: variant_plan.probabilities.get(job, 1.0) for job in config.classifier_jobs},
          selected_jobs=variant_plan.classifier_jobs,
          abstain=variant_plan.abstain,
          stability_variant=f"seed-{variant_model.training_seed}",
          **common,
        ))
      baseline_cases.append(EvaluationCase(
        probabilities={job: baseline_plan.probabilities[job] for job in config.classifier_jobs},
        selected_jobs=baseline_plan.classifier_jobs,
        abstain=baseline_plan.abstain,
        **common,
      ))
    report = evaluate(
      tuple(cases),
      required_epochs=policy.required_epochs,
      baseline_cases=tuple(baseline_cases),
      stability_cases=tuple(stability_cases),
    )
    workflow_bytes = (args.repo_root / ".github/workflows/ci.yml").read_bytes()
    evidence = build_promotion_evidence(
      report=report,
      policy=policy,
      dataset_sha256=dataset_sha,
      model_checksum=model.checksum,
      job_config_sha256=config.checksum(),
      workflow_sha256=sha256(workflow_bytes).hexdigest(),
      required_jobs=config.classifier_jobs,
      deterministic_adapter_sha256=target_adapter.checksum(),
    )
    model_bytes = (model.model_dump_json(indent=2) + "\n").encode()
    evidence_payload = {
      "evaluation": report.model_dump(mode="json"),
      "promotion": evidence.model_dump(mode="json"),
      "temporal_split": {
        "training_prs": [record.pull_request_number for record in train_records],
        "holdout_prs": [record.pull_request_number for record in holdout_records],
      },
      "stability_variants": [
        {"training_seed": item.training_seed, "model_checksum": item.checksum} for item in models
      ],
    }
    evaluation_bytes = (json.dumps(evidence_payload, indent=2, sort_keys=True) + "\n").encode()
    feature_schema = json.dumps(
      {"schema_version": "ci-impact-features-v1", "feature_names": model.feature_names},
      sort_keys=True,
      separators=(",", ":"),
    ).encode()
    registry = CiImpactRegistry(args.registry)
    model_ref = registry.register_blob("ci-impact-model", "1", model_bytes)
    evaluation_ref = registry.register_blob("ci-impact-evaluation", "1", evaluation_bytes)
    blockers = list(evidence.blockers)
    if git_dirty:
      blockers.append("dirty_git")
    runtime_text = f"python:{platform.python_version()}:{platform.python_implementation()}"
    manifest = CiImpactCandidateManifest.create(
      candidate_id=args.candidate_id,
      git_sha=git_sha,
      git_dirty=git_dirty,
      dataset_sha256=dataset_sha,
      feature_schema_sha256=sha256(feature_schema).hexdigest(),
      job_config_sha256=config.checksum(),
      workflow_sha256=sha256(workflow_bytes).hexdigest(),
      promotion_policy_sha256=policy.checksum(),
      implementation_sha256=implementation_checksum(PROJECT_ROOT),
      deterministic_adapter_sha256=target_adapter.checksum(),
      runtime=CiImpactRuntimeLineage(
        name="python",
        version=platform.python_version(),
        digest=sha256(runtime_text.encode()).hexdigest(),
      ),
      model=model_ref,
      evaluation=evaluation_ref,
      promotion_eligible=not blockers,
      blockers=tuple(blockers),
    )
    registry.register_manifest(manifest)
    _write_once(args.model_cache, model_bytes)
    _write_once(args.output, (manifest.model_dump_json(indent=2) + "\n").encode())
    print(json.dumps({
      "candidate_id": manifest.candidate_id,
      "promotion_eligible": manifest.promotion_eligible,
      "blockers": manifest.blockers,
    }))
    return 0 if manifest.promotion_eligible else 3
  except (OSError, ValueError, subprocess.SubprocessError) as issue:
    print(f"ci-impact-candidate-blocked: {issue}", file=sys.stderr)
    return 2


if __name__ == "__main__":
  raise SystemExit(main())
