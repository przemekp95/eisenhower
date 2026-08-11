from __future__ import annotations

from datetime import UTC, datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

import pytest

from app.ci_impact.artifacts import CiImpactCandidateManifest, CiImpactRegistry, CiImpactRuntimeLineage
from app.ci_impact.baseline import RuleBaseline
from app.ci_impact.classifier import MultilabelLogisticModel, TrainingExample
from app.ci_impact.deterministic import verify_deterministic_plan
from app.ci_impact.evaluation import EvaluationCase, evaluate, temporal_holdout
from app.ci_impact.features import FeatureExtractor, LocalDependencyGraph
from app.ci_impact.git_changes import changes_between
from app.ci_impact.history import normalize_github_pr, write_dataset
from app.ci_impact.models import (
  ChangeFile, ChangeSet, DeterministicTargetAdapter, FeatureVector, HistoryRecord, JobConfig,
  JobLabel, ShadowPlan,
)
from app.ci_impact.promotion import CiImpactPromotionEvidence, PromotionPolicy, build_promotion_evidence
from app.ci_impact.process import BoundedProcessError, run_bounded
from app.ci_impact.shadow import ShadowPlanner
from app.ci_impact.training import classify_epochs, require_reviewed_training_labels
from app.ci_impact.workflow import validate_repository_job_universe
from scripts import collect_ci_impact_history as history_collector


ALL_JOBS = (
  "security-lint",
  "test-backend-node",
  "test-frontend",
  "test-frontend-e2e",
  "test-frontend-integration",
  "test-backend-ai",
  "test-mobile",
  "test-mobile-native-android",
)


def job_config() -> JobConfig:
  return JobConfig(
    schema_version="ci-impact-jobs-v1",
    all_jobs=ALL_JOBS,
    required_context_jobs=ALL_JOBS,
    deterministic_jobs=("security-lint",),
    probability_thresholds={job: 0.7 for job in ALL_JOBS},
    known_path_prefixes=(
      "backend/", "backend-ai/", "web/", "mobile/", ".github/", "packages/", "docs/", ".tasks/",
    ),
    rule_paths={
      "backend-ai/": ("test-backend-ai",),
      "web/": ("test-frontend", "test-frontend-e2e", "test-frontend-integration"),
      "mobile/": ("test-mobile", "test-mobile-native-android"),
    },
  )


def fixed_model(feature_names: tuple[str, ...], *, bias: float = 2.0) -> MultilabelLogisticModel:
  classifier_jobs = tuple(job for job in ALL_JOBS if job != "security-lint")
  weights = {job: {name: 0.0 for name in feature_names} for job in classifier_jobs}
  biases = {job: bias for job in classifier_jobs}
  return MultilabelLogisticModel.create(
    job_ids=classifier_jobs,
    feature_names=feature_names,
    weights=weights,
    biases=biases,
    training_dataset_sha256="1" * 64,
    training_seed=7,
  )


def test_features_cover_change_epochs_and_dependency_graph(tmp_path: Path):
  (tmp_path / "backend-ai" / "app").mkdir(parents=True)
  (tmp_path / "backend-ai" / "app" / "leaf.py").write_text("VALUE = 1\n", encoding="utf-8")
  (tmp_path / "backend-ai" / "app" / "consumer.py").write_text(
    "from app.leaf import VALUE\n", encoding="utf-8"
  )
  graph = LocalDependencyGraph.from_repository(tmp_path)
  extractor = FeatureExtractor(config=job_config(), dependency_graph=graph)
  changes = ChangeSet(
    base_sha="a" * 40,
    head_sha="b" * 40,
    files=(
      ChangeFile(path="backend-ai/app/leaf.py", status="modified", additions=4, deletions=1),
      ChangeFile(
        path="backend-ai/app/new_name.py", previous_path="backend-ai/app/old_name.py",
        status="renamed", additions=1, deletions=1,
      ),
      ChangeFile(path="package-lock.json", status="modified", additions=30, deletions=20),
      ChangeFile(path="assets/logo.png", status="modified", additions=0, deletions=0, binary=True),
      ChangeFile(path="backend-ai/app/removed.py", status="deleted", additions=0, deletions=12),
    ),
  )
  vector = extractor.extract(changes, auxiliary_diff_embedding=(0.25, -0.5))

  assert vector.values["change.rename"] == 1
  assert vector.values["change.delete"] == 1
  assert vector.values["change.binary"] == 1
  assert vector.values["change.lockfile"] == 1
  assert vector.values["diff.lines"] == 69
  assert vector.values["dependency.impacted_count"] >= 1
  assert "backend-ai/app/consumer.py" in vector.dependency_impacts
  assert vector.values["aux.diff_embedding.0"] == pytest.approx(0.25)
  assert vector.unknown_paths == ("assets/logo.png", "package-lock.json")


def test_workflow_manifest_and_unknown_paths_force_shadow_abstention():
  config = job_config()
  extractor = FeatureExtractor(config=config)
  for changed_path in (".github/workflows/ci.yml", "package.json", "unknown/new.stack"):
    changes = ChangeSet(
      base_sha="a" * 40,
      head_sha="b" * 40,
      files=(ChangeFile(path=changed_path, status="modified", additions=1, deletions=1),),
    )
    features = extractor.extract(changes)
    model = fixed_model(tuple(features.values))
    plan = ShadowPlanner(config=config).plan(changes=changes, features=features, model=model)
    assert plan.abstain is True
    assert plan.effective_jobs == ALL_JOBS
    assert plan.full_ci is True


def test_rule_baseline_is_conservative_and_uses_additive_jobs():
  config = job_config()
  known = ChangeSet(
    base_sha="a" * 40,
    head_sha="b" * 40,
    files=(ChangeFile(path="backend-ai/app/service.py", status="modified", additions=1),),
  )
  known_features = FeatureExtractor(config=config).extract(known)
  plan = RuleBaseline(config).plan(changes=known, features=known_features)
  assert plan.full_ci is False
  assert plan.effective_jobs == ("security-lint", "test-backend-ai")
  assert plan.probabilities["test-backend-ai"] == 1.0

  unknown = ChangeSet(
    base_sha="a" * 40,
    head_sha="b" * 40,
    files=(ChangeFile(path="new-runtime/module.xyz", status="added", additions=1),),
  )
  unknown_features = FeatureExtractor(config=config).extract(unknown)
  blocked = RuleBaseline(config).plan(changes=unknown, features=unknown_features)
  assert blocked.full_ci is True
  assert blocked.effective_jobs == ALL_JOBS


def test_shadow_is_additive_and_every_model_failure_runs_full_ci():
  config = job_config()
  changes = ChangeSet(
    base_sha="a" * 40,
    head_sha="b" * 40,
    files=(ChangeFile(path="backend-ai/app/service.py", status="modified", additions=3, deletions=1),),
  )
  features = FeatureExtractor(config=config).extract(changes)
  model = fixed_model(tuple(features.values))
  plan = ShadowPlanner(config=config, minimum_margin=0.1).plan(
    changes=changes, features=features, model=model, deterministic_plan_verified=True
  )
  assert set(config.deterministic_jobs).issubset(plan.effective_jobs)
  assert plan.effective_jobs == tuple(dict.fromkeys((*plan.deterministic_jobs, *plan.classifier_jobs)))
  assert plan.full_ci is False

  missing_plan = ShadowPlanner(config=config, minimum_margin=0.1).plan(
    changes=changes, features=features, model=model
  )
  assert missing_plan.full_ci is True
  assert "deterministic_plan_unverified" in missing_plan.reasons

  for kwargs, reason in (
    ({"model": None}, "model_unavailable"),
    ({"model": model, "expected_model_checksum": "f" * 64}, "checksum_mismatch"),
    ({"model": model, "drift_detected": True}, "drift_detected"),
    ({"model": fixed_model(tuple(features.values), bias=0.85)}, "low_confidence"),
  ):
    blocked = ShadowPlanner(config=config, minimum_margin=0.2).plan(
      changes=changes, features=features, **kwargs
    )
    assert blocked.abstain is True
    assert blocked.full_ci is True
    assert blocked.effective_jobs == ALL_JOBS
    assert reason in blocked.reasons

  lineage_blocked = ShadowPlanner(config=config).plan(
    changes=changes,
    features=features,
    model=model,
    blocking_reasons=("workflow_job_universe_mismatch",),
  )
  assert lineage_blocked.full_ci is True
  assert "workflow_job_universe_mismatch" in lineage_blocked.reasons

  with pytest.raises(ValueError, match="exact canonical"):
    ShadowPlan(
      probabilities={}, canonical_jobs=ALL_JOBS, deterministic_jobs=("security-lint",),
      classifier_jobs=(), effective_jobs=ALL_JOBS[:-1], abstain=True, full_ci=True,
      reasons=("invalid_fixture",),
    )


def test_training_is_multilabel_and_ignores_unknown_labels():
  examples = (
    TrainingExample(
      features={"path.backend-ai": 1.0, "path.web": 0.0},
      labels={"test-backend-ai": "required", "test-frontend": "safe_to_skip"},
    ),
    TrainingExample(
      features={"path.backend-ai": 0.0, "path.web": 1.0},
      labels={"test-backend-ai": "safe_to_skip", "test-frontend": "required"},
    ),
    TrainingExample(
      features={"path.backend-ai": 1.0, "path.web": 1.0},
      labels={"test-backend-ai": "unknown", "test-frontend": "required"},
    ),
  )
  model = MultilabelLogisticModel.train(
    examples=examples,
    job_ids=("test-backend-ai", "test-frontend"),
    dataset_sha256="2" * 64,
    epochs=300,
    learning_rate=0.2,
  )
  backend = model.predict({"path.backend-ai": 1.0, "path.web": 0.0})
  frontend = model.predict({"path.backend-ai": 0.0, "path.web": 1.0})
  assert backend["test-backend-ai"] > backend["test-frontend"]
  assert frontend["test-frontend"] > frontend["test-backend-ai"]
  assert model.schema_version == "ci-impact-model-v1"


def test_dependency_graph_is_reconstructed_from_exact_git_epoch(tmp_path: Path):
  (tmp_path / "backend-ai/app").mkdir(parents=True)
  (tmp_path / "backend-ai/app/leaf.py").write_text("VALUE = 1\n", encoding="utf-8")
  (tmp_path / "backend-ai/app/consumer.py").write_text(
    "from app.leaf import VALUE\n", encoding="utf-8"
  )
  for command in (
    ("git", "init", "-q"),
    ("git", "add", "."),
    ("git", "-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "commit", "-qm", "epoch"),
  ):
    subprocess.run(command, cwd=tmp_path, check=True)
  revision = subprocess.run(
    ("git", "rev-parse", "HEAD"), cwd=tmp_path, check=True, capture_output=True, text=True
  ).stdout.strip()
  graph = LocalDependencyGraph.from_git_revision(tmp_path, revision)
  assert graph.impacted_by({"backend-ai/app/leaf.py"}) == ("backend-ai/app/consumer.py",)
  assert graph.unresolved == 0
  bounded = LocalDependencyGraph.from_git_revision(tmp_path, revision, maximum_file_bytes=5)
  assert bounded.relevant_unresolved({"backend-ai/app/leaf.py"}) == (
    "backend-ai/app/consumer.py", "backend-ai/app/leaf.py",
  )
  with pytest.raises(ValueError, match="full Git SHA"):
    LocalDependencyGraph.from_git_revision(tmp_path, "HEAD")


def test_dependency_graph_combines_base_and_head_for_relative_import_delete(tmp_path: Path):
  (tmp_path / "backend-ai/app/domain").mkdir(parents=True)
  (tmp_path / "backend-ai/app/domain/leaf.py").write_text("VALUE = 1\n", encoding="utf-8")
  consumer = tmp_path / "backend-ai/app/domain/consumer.py"
  consumer.write_text("from .leaf import VALUE\n", encoding="utf-8")
  for command in (
    ("git", "init", "-q"), ("git", "add", "."),
    ("git", "-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "commit", "-qm", "base"),
  ):
    subprocess.run(command, cwd=tmp_path, check=True)
  base = subprocess.run(
    ("git", "rev-parse", "HEAD"), cwd=tmp_path, check=True, capture_output=True, text=True
  ).stdout.strip()
  (tmp_path / "backend-ai/app/domain/leaf.py").unlink()
  subprocess.run(("git", "add", "-A"), cwd=tmp_path, check=True)
  subprocess.run(
    ("git", "-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "commit", "-qm", "delete"),
    cwd=tmp_path, check=True,
  )
  head = subprocess.run(
    ("git", "rev-parse", "HEAD"), cwd=tmp_path, check=True, capture_output=True, text=True
  ).stdout.strip()
  graph = LocalDependencyGraph.combine(
    LocalDependencyGraph.from_git_revision(tmp_path, base),
    LocalDependencyGraph.from_git_revision(tmp_path, head),
  )
  assert graph.impacted_by({"backend-ai/app/domain/leaf.py"}) == (
    "backend-ai/app/domain/consumer.py",
  )


def test_dependency_graph_traverses_consumers_beyond_twenty_hops():
  reverse = {f"module-{index}.py": {f"module-{index + 1}.py"} for index in range(25)}
  graph = LocalDependencyGraph(reverse_edges=reverse)
  impacted = graph.impacted_by({"module-0.py"})
  assert len(impacted) == 25
  assert "module-25.py" in impacted


def test_dependency_graph_syntax_error_and_oversized_source_are_unresolved(tmp_path: Path):
  source = tmp_path / "backend-ai/app/broken.py"
  source.parent.mkdir(parents=True)
  source.write_text("def broken(:\n", encoding="utf-8")
  graph = LocalDependencyGraph.from_repository(tmp_path)
  assert graph.relevant_unresolved({"backend-ai/app/broken.py"}) == ("backend-ai/app/broken.py",)
  source.write_text("x" * 100, encoding="utf-8")
  bounded = LocalDependencyGraph.from_repository(tmp_path, maximum_file_bytes=10)
  assert bounded.relevant_unresolved({"backend-ai/app/broken.py"}) == ("backend-ai/app/broken.py",)


def test_dynamic_python_import_is_conservatively_unresolved(tmp_path: Path):
  source = tmp_path / "backend-ai/app/dynamic.py"
  source.parent.mkdir(parents=True)
  source.write_text("import importlib\nvalue = importlib.import_module(name)\n", encoding="utf-8")
  graph = LocalDependencyGraph.from_repository(tmp_path)
  assert graph.relevant_unresolved({"backend-ai/app/dynamic.py"}) == ("backend-ai/app/dynamic.py",)
  assert graph.relevant_unresolved({"backend-ai/app/another.py"}) == ("backend-ai/app/dynamic.py",)


def test_bounded_process_limits_output_and_time(tmp_path: Path):
  with pytest.raises(BoundedProcessError, match="stdout limit"):
    run_bounded(
      (sys.executable, "-c", "print('x' * 10000)"), cwd=tmp_path, maximum_stdout_bytes=100
    )
  with pytest.raises(BoundedProcessError, match="timed out"):
    run_bounded(
      (sys.executable, "-c", "import time; time.sleep(1)"), cwd=tmp_path, timeout_seconds=0.05
    )


def test_git_change_set_is_derived_from_exact_revisions(tmp_path: Path):
  (tmp_path / "old.py").write_text("one\n", encoding="utf-8")
  subprocess.run(("git", "init", "-q"), cwd=tmp_path, check=True)
  subprocess.run(("git", "add", "."), cwd=tmp_path, check=True)
  subprocess.run(
    ("git", "-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "commit", "-qm", "base"),
    cwd=tmp_path, check=True,
  )
  base = subprocess.run(
    ("git", "rev-parse", "HEAD"), cwd=tmp_path, check=True, capture_output=True, text=True
  ).stdout.strip()
  (tmp_path / "old.py").rename(tmp_path / "new.py")
  (tmp_path / "new.py").write_text("one\ntwo\n", encoding="utf-8")
  subprocess.run(("git", "add", "-A"), cwd=tmp_path, check=True)
  subprocess.run(
    ("git", "-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "commit", "-qm", "head"),
    cwd=tmp_path, check=True,
  )
  changes = changes_between(tmp_path, base, "HEAD")
  assert changes.base_sha == base
  assert changes.files[0].path == "new.py"
  assert changes.files[0].previous_path == "old.py"
  assert changes.files[0].status == "renamed"
  assert changes.files[0].additions == 1


def test_history_keeps_green_jobs_unknown_until_manual_review(tmp_path: Path):
  record = normalize_github_pr(
    pull_request={
      "number": 156, "merged_at": "2026-08-11T10:00:00Z",
      "base_sha": "a" * 40, "head_sha": "b" * 40,
    },
    files=[{"filename": "backend-ai/app/service.py", "status": "modified", "additions": 2, "deletions": 1}],
    job_results=[
      {"name": "test-backend-ai", "conclusion": "success"},
      {"name": "test-frontend", "conclusion": "success"},
    ],
    all_jobs=("test-backend-ai", "test-frontend"),
  )
  assert record.labels == {
    "test-backend-ai": JobLabel(value="unknown", provenance="manual_review_required"),
    "test-frontend": JobLabel(value="unknown", provenance="manual_review_required"),
  }
  assert record.changes.files[0].binary is True
  dataset_path = tmp_path / "history-v1.jsonl"
  receipt = write_dataset(dataset_path, (record,))
  assert receipt.schema_version == "ci-impact-dataset-v1"
  assert receipt.record_count == 1
  assert receipt.sha256 == sha256(dataset_path.read_bytes()).hexdigest()
  assert write_dataset(dataset_path, (record,)) == receipt
  with pytest.raises(ValueError, match="immutable"):
    write_dataset(dataset_path, ())


def test_collector_binds_check_evidence_to_actions_suite_and_pr_head(monkeypatch):
  pull = {
    "number": 160, "merged_at": "2026-08-11T23:00:00Z",
    "base": {"ref": "dev", "sha": "a" * 40, "repo": {"full_name": "owner/repo"}},
    "head": {"sha": "b" * 40},
  }
  trusted = {
    "name": "test-backend-ai", "conclusion": "success", "id": 1, "run_attempt": 1,
    "check_suite": {"id": 10}, "app": {"slug": "github-actions"},
  }
  foreign = {
    **trusted, "id": 2, "check_suite": {"id": 20},
  }

  def fake_gh(endpoint: str, **_kwargs):
    if endpoint.endswith("pulls?state=closed&base=dev&per_page=100"):
      return [[pull]]
    if endpoint.endswith("pulls/160/files?per_page=100"):
      return [[{
        "filename": "backend-ai/app/service.py", "status": "modified",
        "additions": 1, "deletions": 0, "patch": "@@",
      }]]
    if "check-runs" in endpoint:
      return [{"check_runs": [trusted, foreign]}]
    if "check-suites" in endpoint:
      return [{"check_suites": [{
        "id": 10, "head_sha": "b" * 40, "app": {"slug": "github-actions"},
      }, {
        "id": 20, "head_sha": "c" * 40, "app": {"slug": "github-actions"},
      }]}]
    return {"sha": "d" * 40}

  monkeypatch.setattr(history_collector, "_gh", fake_gh)
  records = history_collector.collect(
    repo="owner/repo", base="dev", minimum_pr=160, maximum_pr=160, config=job_config()
  )
  assert len(records[0].job_results) == 1
  assert records[0].job_results[0].run_id == 1
  with pytest.raises(ValueError, match="range"):
    history_collector.collect(
      repo="owner/repo", base="dev", minimum_pr=1, maximum_pr=251, config=job_config()
    )


def test_latest_dataset_remains_unknown_and_cannot_authenticate_reviewers():
  dataset = (
    Path(__file__).resolve().parents[1]
    / "ci-impact/datasets/github-pr-141-160-authenticated-v1.jsonl"
  )
  records = tuple(
    HistoryRecord.model_validate_json(line) for line in dataset.read_text(encoding="utf-8").splitlines()
  )
  assert records
  assert {label.value for record in records for label in record.labels.values()} == {"unknown"}


def test_temporal_holdout_and_metrics_cover_required_safety_calibration_and_epochs():
  start = datetime(2026, 1, 1, tzinfo=UTC)
  records = tuple(
    normalize_github_pr(
      pull_request={
        "number": index + 1, "merged_at": (start + timedelta(days=index)).isoformat(),
        "base_sha": f"{index:040x}", "head_sha": f"{index + 1:040x}",
      },
      files=[{"filename": "backend-ai/app/service.py", "status": "modified", "additions": 1, "deletions": 0}],
      job_results=[], all_jobs=("test-backend-ai",),
    )
    for index in range(10)
  )
  train, holdout = temporal_holdout(records, holdout_fraction=0.3)
  assert len(train) == 7 and len(holdout) == 3
  assert max(item.merged_at for item in train) < min(item.merged_at for item in holdout)

  cases = (
    EvaluationCase(
      epoch="dependency", probabilities={"job": 0.9}, selected_jobs=("job",),
      labels={"job": "required"}, abstain=False,
    ),
    EvaluationCase(
      epoch="rename", probabilities={"job": 0.8}, selected_jobs=("job",),
      labels={"job": "safe_to_skip"}, abstain=False,
    ),
    EvaluationCase(
      epoch="unknown_paths", probabilities={"job": 0.5}, selected_jobs=(),
      labels={"job": "unknown"}, abstain=True,
    ),
  )
  report = evaluate(cases, required_epochs=("dependency", "rename", "unknown_paths"))
  assert report.per_job["job"].required_job_recall == 1.0
  assert report.per_job["job"].unsafe_skip_rate == 0.0
  assert report.per_job["job"].precision == 0.5
  assert 0 <= report.per_job["job"].brier_score <= 1
  assert report.abstention_coverage == pytest.approx(1 / 3)
  assert report.epoch_coverage == ("dependency", "rename", "unknown_paths")


def test_ci_impact_lineage_is_separate_immutable_and_checksum_bound(tmp_path: Path):
  model_payload = json.dumps({"schema_version": "ci-impact-model-v1"}, sort_keys=True).encode()
  report_payload = json.dumps({"schema_version": "ci-impact-evaluation-v1"}, sort_keys=True).encode()
  registry = CiImpactRegistry(tmp_path / "registry")
  model_ref = registry.register_blob("model", "1", model_payload)
  report_ref = registry.register_blob("evaluation", "1", report_payload)
  manifest = CiImpactCandidateManifest.create(
    candidate_id="ci-impact-local-1",
    git_sha="a" * 40,
    git_dirty=False,
    dataset_sha256="b" * 64,
    feature_schema_sha256="c" * 64,
    job_config_sha256="d" * 64,
    workflow_sha256="e" * 64,
    promotion_policy_sha256="1" * 64,
    implementation_sha256="2" * 64,
    deterministic_adapter_sha256="3" * 64,
    runtime=CiImpactRuntimeLineage(name="python", version="3.12", digest="f" * 64),
    model=model_ref,
    evaluation=report_ref,
    promotion_eligible=False,
    blockers=("manual_labels_missing", "quality_thresholds_unapproved"),
  )
  registry.register_manifest(manifest)
  assert manifest.schema_version == "ci-impact-candidate-v1"
  assert registry.load_manifest(manifest.candidate_id) == manifest
  registry.register_manifest(manifest)

  path = registry.manifest_path(manifest.candidate_id)
  path.write_text(path.read_text(encoding="utf-8").replace("manual_labels_missing", "tampered_label_value"), encoding="utf-8")
  with pytest.raises(ValueError, match="checksum|invalid"):
    registry.load_manifest(manifest.candidate_id)


@pytest.mark.parametrize(
  ("change", "expected_epoch"),
  (
    (ChangeFile(path=".github/workflows/ci.yml", status="modified", additions=1), "workflow"),
    (ChangeFile(path="package-lock.json", status="modified", additions=1), "lockfile"),
    (ChangeFile(path="backend-ai/new.py", previous_path="backend-ai/old.py", status="renamed"), "rename"),
    (ChangeFile(path="mobile/eisenhower-matrix/assets/icon.png", status="modified", binary=True), "binary"),
    (ChangeFile(path="unknown-stack/module.xyz", status="added", additions=1), "unknown_paths"),
    (ChangeFile(path="backend-ai/app/service.py", status="deleted", deletions=4), "delete"),
  ),
)
def test_epoch_classification_is_explicit(change: ChangeFile, expected_epoch: str):
  changes = ChangeSet(base_sha="a" * 40, head_sha="b" * 40, files=(change,))
  features = FeatureExtractor(config=job_config()).extract(changes)
  assert expected_epoch in classify_epochs(changes, features)


def test_repository_job_universe_drift_is_explicit(tmp_path: Path):
  (tmp_path / ".github/workflows").mkdir(parents=True)
  (tmp_path / ".github/scripts").mkdir(parents=True)
  (tmp_path / ".github/workflows/ci.yml").write_text(
    "jobs:\n  resolve-run-mode:\n  security-lint:\n", encoding="utf-8"
  )
  (tmp_path / ".github/workflows/branch-policy.yml").write_text(
    "name: Branch Policy\njobs:\n  branch-policy:\n", encoding="utf-8"
  )
  (tmp_path / ".github/scripts/bridge-sync-pr-statuses.mjs").write_text(
    "CI: ['security-lint'],\n'Branch Policy': ['branch-policy'],\n", encoding="utf-8"
  )
  (tmp_path / ".github/workflows/sync-master-into-dev.yml").write_text(
    "required_jobs=(\n security-lint\n )\n", encoding="utf-8"
  )
  reasons = validate_repository_job_universe(tmp_path, job_config())
  assert reasons == (
    "workflow_job_universe_mismatch",
    "bridge_job_universe_mismatch",
    "sync_job_universe_mismatch",
  )


def test_missing_repository_job_contracts_fail_closed(tmp_path: Path):
  assert validate_repository_job_universe(tmp_path, job_config()) == (
    "workflow_job_universe_mismatch",
    "bridge_job_universe_mismatch",
    "branch_policy_context_mismatch",
    "sync_job_universe_mismatch",
  )


def test_checked_in_job_config_matches_current_workflows():
  repo_root = Path(__file__).resolve().parents[2]
  config = JobConfig.model_validate_json(
    (repo_root / "backend-ai/ci-impact/config/jobs-v1.json").read_text(encoding="utf-8")
  )
  assert {"test-api-client", "test-mcp-adapter"}.issubset(config.all_jobs)
  assert not validate_repository_job_universe(repo_root, config)


def test_deterministic_target_adapter_maps_planner_targets_additively():
  repo_root = Path(__file__).resolve().parents[2]
  config = JobConfig.model_validate_json(
    (repo_root / "backend-ai/ci-impact/config/jobs-v1.json").read_text(encoding="utf-8")
  )
  adapter = DeterministicTargetAdapter.model_validate_json(
    (repo_root / "backend-ai/ci-impact/config/deterministic-target-jobs-v1.json").read_text(
      encoding="utf-8"
    )
  )
  assert adapter.jobs_for(("security-lint", "n8n", "backend-ai"), config) == (
    "security-lint", "test-n8n-workflows", "test-backend-ai",
  )
  with pytest.raises(ValueError, match="unknown target"):
    adapter.jobs_for(("invented-target",), config)


def test_deterministic_plan_is_bound_to_sha_changes_and_digest():
  config = job_config()
  adapter = DeterministicTargetAdapter(
    plan_version="ci-impact-plan/v1",
    target_to_jobs={"security-lint": ("security-lint",), "backend-ai": ("test-backend-ai",)},
  )
  changes = ({"status": "M", "path": "backend-ai/app/service.py"},)
  digest_input = {
    "version": "ci-impact-plan/v1", "eventName": "pull_request", "refName": "feature",
    "baseRefName": "dev", "mergeBase": "a" * 40, "headSha": "b" * 40,
    "changes": list(changes), "error": None,
  }
  payload = {
    **{key: digest_input[key] for key in (
      "version", "eventName", "refName", "baseRefName", "mergeBase", "headSha",
    )},
    "inputDigest": "sha256:" + sha256(json.dumps(
      digest_input, ensure_ascii=False, separators=(",", ":")
    ).encode()).hexdigest(),
    "fullCi": False,
    "targets": ["backend-ai", "security-lint"],
    "reasons": {"backend-ai": ["test"], "security-lint": ["test"]},
    "changes": list(changes),
  }
  jobs, full_ci = verify_deterministic_plan(
    payload, expected_base_sha="a" * 40, expected_head_sha="b" * 40,
    expected_changes=changes, expected_event_name="pull_request", expected_ref_name="feature",
    expected_base_ref_name="dev", authoritative_plan=payload, adapter=adapter, config=config,
  )
  assert jobs == ("security-lint", "test-backend-ai")
  assert full_ci is False
  for field, value, message in (
    ("headSha", "c" * 40, "revision"),
    ("changes", [], "changes"),
    ("inputDigest", "sha256:" + "0" * 64, "digest"),
    ("targets", ["backend-ai"], "canonical planner"),
    ("fullCi", True, "canonical planner"),
  ):
    stale = {**payload, field: value}
    with pytest.raises(ValueError, match=message):
      verify_deterministic_plan(
        stale, expected_base_sha="a" * 40, expected_head_sha="b" * 40,
        expected_changes=changes, expected_event_name="pull_request", expected_ref_name="feature",
        expected_base_ref_name="dev", authoritative_plan=payload, adapter=adapter, config=config,
      )


@pytest.mark.parametrize(
  "update",
  (
    {"known_path_prefixes": ("",)},
    {"known_path_prefixes": ("../",)},
    {"known_path_prefixes": ("backend-ai",)},
    {"known_path_prefixes": ("backend-ai/", "backend-ai/")},
    {"rule_paths": {"": ("test-backend-ai",)}},
    {"rule_paths": {"outside/": ("test-backend-ai",)}},
  ),
)
def test_job_config_rejects_unscoped_or_malformed_path_prefixes(update: dict):
  values = job_config().model_dump(mode="python")
  values.update(update)
  with pytest.raises(ValueError, match="prefix|rule path|unsafe segment"):
    JobConfig(**values)


def test_unreviewed_history_cannot_train_or_claim_promotion():
  record = normalize_github_pr(
    pull_request={
      "number": 156, "merged_at": "2026-08-11T10:00:00Z",
      "base_sha": "a" * 40, "head_sha": "b" * 40,
    },
    files=[{"filename": "backend-ai/app/service.py", "status": "modified", "additions": 2, "deletions": 1}],
    job_results=[{"name": "test-backend-ai", "conclusion": "success"}],
    all_jobs=("test-backend-ai",),
  )
  with pytest.raises(ValueError, match="manual labels"):
    require_reviewed_training_labels((record,), ("test-backend-ai",))


def test_promotion_evidence_requires_metrics_epochs_baseline_and_zero_unsafe_skips():
  epochs = ("dependency", "workflow", "lockfile", "rename", "binary", "unknown_paths")
  base_cases = tuple(
    EvaluationCase(
      epoch=epoch,
      probabilities={"job": 0.99 if index % 2 == 0 else 0.01},
      selected_jobs=("job",) if index % 2 == 0 else (),
      labels={"job": "required" if index % 2 == 0 else "safe_to_skip"},
      abstain=False,
      change_fingerprint=f"stable-{index}",
    )
    for index, epoch in enumerate(epochs)
  )
  stability_cases = tuple(
    case.model_copy(update={"stability_variant": variant})
    for case in base_cases for variant in ("seed-7", "seed-19")
  )
  cases = base_cases
  report = evaluate(
    cases, required_epochs=epochs, baseline_cases=cases, stability_cases=stability_cases
  )
  evidence = build_promotion_evidence(
    report=report,
    policy=PromotionPolicy(
      owner_approved=True,
      minimum_required_support=3,
      minimum_safe_to_skip_support=3,
      minimum_required_recall=1.0,
      maximum_unsafe_skip_rate=0.0,
      minimum_precision=0.99,
      maximum_brier_score=0.01,
      maximum_expected_calibration_error=0.02,
      maximum_abstention_coverage=0.5,
      minimum_stability=0.99,
      required_epochs=epochs,
    ),
    dataset_sha256="a" * 64,
    model_checksum="b" * 64,
    job_config_sha256="c" * 64,
    workflow_sha256="d" * 64,
    required_jobs=("job",),
    deterministic_adapter_sha256="f" * 64,
  )
  assert evidence.passed is False
  assert evidence.blockers == ("trusted_owner_approval_verifier_unavailable",)
  assert evidence.approval_verified is False
  assert evidence.approval_receipt_sha256 is None

  unsafe_report = evaluate(
    cases + (EvaluationCase(
      epoch="dependency", probabilities={"job": 0.01}, selected_jobs=(),
      labels={"job": "required"}, abstain=False,
    ),),
    required_epochs=epochs,
    baseline_cases=cases,
    stability_cases=stability_cases,
  )
  unsafe = build_promotion_evidence(
    report=unsafe_report,
    policy=PromotionPolicy(
      owner_approved=True,
      minimum_required_support=1, minimum_safe_to_skip_support=1,
      minimum_required_recall=1.0, maximum_unsafe_skip_rate=0.0,
      minimum_precision=0.0, maximum_brier_score=1.0,
      maximum_expected_calibration_error=1.0, maximum_abstention_coverage=1.0,
      minimum_stability=0.0, required_epochs=epochs,
    ),
    dataset_sha256="a" * 64, model_checksum="b" * 64,
    job_config_sha256="c" * 64, workflow_sha256="d" * 64,
    required_jobs=("job",),
    deterministic_adapter_sha256="f" * 64,
  )
  assert unsafe.passed is False
  assert any("unsafe_skip_rate" in blocker for blocker in unsafe.blockers)


def test_abstention_counts_as_counterfactual_required_miss():
  report = evaluate((EvaluationCase(
    epoch="dependency",
    probabilities={"job": 0.99},
    selected_jobs=("job",),
    labels={"job": "required"},
    abstain=True,
  ),), required_epochs=("dependency",))
  metrics = report.per_job["job"]
  assert metrics.required_job_recall == 0.0
  assert metrics.unsafe_skip_rate == 1.0


@pytest.mark.parametrize(
  ("filename", "model"),
  (
    ("candidate-v1.schema.json", CiImpactCandidateManifest),
    ("deterministic-adapter-v1.schema.json", DeterministicTargetAdapter),
    ("features-v1.schema.json", FeatureVector),
    ("history-record-v1.schema.json", HistoryRecord),
    ("model-v1.schema.json", MultilabelLogisticModel),
    ("promotion-evidence-v1.schema.json", CiImpactPromotionEvidence),
    ("shadow-plan-v1.schema.json", ShadowPlan),
  ),
)
def test_published_json_schemas_are_generated_from_runtime_contracts(filename: str, model):
  schema_path = Path(__file__).resolve().parents[1] / "ci-impact/schemas" / filename
  published = json.loads(schema_path.read_text(encoding="utf-8"))
  expected = model.model_json_schema()
  expected["$schema"] = "https://json-schema.org/draft/2020-12/schema"
  expected["$id"] = f"https://eisenhower.invalid/schemas/{filename}"
  assert published == expected
