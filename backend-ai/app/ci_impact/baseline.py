from __future__ import annotations

from app.ci_impact.models import ChangeSet, FeatureVector, JobConfig, ShadowPlan


class RuleBaseline:
  """Conservative reference baseline evaluated on the same holdout as learned models."""

  def __init__(self, config: JobConfig):
    self.config = config

  def plan(self, *, changes: ChangeSet, features: FeatureVector) -> ShadowPlan:
    selected = list(self.config.deterministic_jobs)
    paths = {
      path for item in changes.files for path in ((item.path,) if item.previous_path is None else (item.path, item.previous_path))
    }
    paths.update(features.dependency_impacts)
    for path in sorted(paths):
      for prefix, jobs in self.config.rule_paths.items():
        if path.startswith(prefix):
          selected.extend(jobs)
    unsafe_scope = bool(
      features.unknown_paths
      or features.values.get("change.workflow", 0)
      or features.values.get("change.manifest", 0)
      or features.values.get("change.lockfile", 0)
      or features.values.get("dependency.unresolved_count", 0)
    )
    selected_jobs = tuple(dict.fromkeys(job for job in self.config.all_jobs if job in selected))
    probabilities = {job: float(job in selected_jobs) for job in self.config.all_jobs}
    if unsafe_scope:
      return ShadowPlan(
        probabilities=probabilities,
        deterministic_jobs=self.config.deterministic_jobs,
        classifier_jobs=selected_jobs,
        effective_jobs=self.config.all_jobs,
        abstain=True,
        full_ci=True,
        reasons=("rule_baseline_abstain",),
      )
    classifier_jobs = tuple(job for job in selected_jobs if job not in self.config.deterministic_jobs)
    return ShadowPlan(
      probabilities=probabilities,
      deterministic_jobs=self.config.deterministic_jobs,
      classifier_jobs=classifier_jobs,
      effective_jobs=tuple(dict.fromkeys((*self.config.deterministic_jobs, *classifier_jobs))),
      abstain=False,
      full_ci=False,
      reasons=(),
    )
