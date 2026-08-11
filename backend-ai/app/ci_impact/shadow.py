from __future__ import annotations

from app.ci_impact.classifier import MultilabelLogisticModel
from app.ci_impact.models import ChangeSet, FeatureVector, JobConfig, ShadowPlan


class ShadowPlanner:
  """Counterfactual-only planner. It has no workflow mutation or skip capability."""

  def __init__(self, *, config: JobConfig, minimum_margin: float = 0.1):
    if not 0 < minimum_margin < 0.5:
      raise ValueError("minimum margin must be between zero and one half")
    self.config = config
    self.minimum_margin = minimum_margin

  def plan(
    self,
    *,
    changes: ChangeSet,
    features: FeatureVector,
    model: MultilabelLogisticModel | None,
    expected_model_checksum: str | None = None,
    drift_detected: bool = False,
    blocking_reasons: tuple[str, ...] = (),
  ) -> ShadowPlan:
    del changes  # The checksum-bound feature vector is the only model input.
    reasons: list[str] = list(blocking_reasons)
    probabilities: dict[str, float] = {}
    classifier_jobs: tuple[str, ...] = ()
    if model is None:
      reasons.append("model_unavailable")
    elif expected_model_checksum is not None and model.checksum != expected_model_checksum:
      reasons.append("checksum_mismatch")
    elif drift_detected:
      reasons.append("drift_detected")
    elif tuple(model.job_ids) != tuple(self.config.classifier_jobs):
      reasons.append("job_universe_mismatch")
    else:
      try:
        model_probabilities = model.predict(features.values)
        probabilities = {
          job: 1.0 if job in self.config.deterministic_jobs else model_probabilities[job]
          for job in self.config.all_jobs
        }
      except (ArithmeticError, OverflowError, ValueError):
        reasons.append("model_error")
      else:
        classifier_jobs = tuple(
          job for job in self.config.classifier_jobs
          if probabilities[job] >= self.config.probability_thresholds[job]
        )
        if any(
          abs(probabilities[job] - self.config.probability_thresholds[job]) < self.minimum_margin
          for job in self.config.classifier_jobs
        ):
          reasons.append("low_confidence")
    if features.unknown_paths:
      reasons.append("out_of_domain_paths")
    if features.values.get("change.workflow", 0) > 0:
      reasons.append("workflow_change")
    if features.values.get("change.lockfile", 0) > 0:
      reasons.append("lockfile_change")
    if features.values.get("change.manifest", 0) > 0:
      reasons.append("manifest_change")
    if features.values.get("dependency.unresolved_count", 0) > 0:
      reasons.append("dependency_graph_incomplete")
    reasons = list(dict.fromkeys(reasons))
    if reasons:
      return ShadowPlan(
        probabilities=probabilities,
        deterministic_jobs=self.config.deterministic_jobs,
        classifier_jobs=classifier_jobs,
        effective_jobs=self.config.all_jobs,
        abstain=True,
        full_ci=True,
        reasons=tuple(reasons),
        model_checksum=model.checksum if model else None,
      )
    effective_jobs = tuple(dict.fromkeys((*self.config.deterministic_jobs, *classifier_jobs)))
    return ShadowPlan(
      probabilities=probabilities,
      deterministic_jobs=self.config.deterministic_jobs,
      classifier_jobs=classifier_jobs,
      effective_jobs=effective_jobs,
      abstain=False,
      full_ci=False,
      reasons=(),
      model_checksum=model.checksum,
    )
