from __future__ import annotations

from hashlib import sha256
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.ci_impact.evaluation import EvaluationReport
from app.ci_impact.models import SHA256_PATTERN


TRUSTED_APPROVAL_VERIFIER_AVAILABLE = False


class PromotionPolicy(BaseModel):
  model_config = ConfigDict(extra="forbid", frozen=True)
  owner_approved: bool
  minimum_required_support: int = Field(..., ge=1)
  minimum_safe_to_skip_support: int = Field(..., ge=1)
  minimum_required_recall: float = Field(..., ge=0, le=1)
  maximum_unsafe_skip_rate: float = Field(..., ge=0, le=1)
  minimum_precision: float = Field(..., ge=0, le=1)
  maximum_brier_score: float = Field(..., ge=0, le=1)
  maximum_expected_calibration_error: float = Field(..., ge=0, le=1)
  maximum_abstention_coverage: float = Field(..., ge=0, le=1)
  minimum_stability: float = Field(..., ge=0, le=1)
  required_epochs: tuple[str, ...] = Field(..., min_length=1)

  def checksum(self) -> str:
    payload = json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return sha256(payload.encode()).hexdigest()


class CiImpactPromotionEvidence(BaseModel):
  model_config = ConfigDict(extra="forbid", frozen=True)
  schema_version: Literal["ci-impact-promotion-evidence-v1"] = "ci-impact-promotion-evidence-v1"
  dataset_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  model_checksum: str = Field(..., pattern=SHA256_PATTERN.pattern)
  job_config_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  workflow_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  promotion_policy_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  deterministic_adapter_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  approval_receipt_sha256: str | None = Field(default=None, pattern=SHA256_PATTERN.pattern)
  approval_verified: bool
  evaluation_checksum: str = Field(..., pattern=SHA256_PATTERN.pattern)
  passed: bool
  blockers: tuple[str, ...]
  checksum: str = Field(..., pattern=SHA256_PATTERN.pattern)

  @classmethod
  def create(cls, **values) -> "CiImpactPromotionEvidence":
    draft = cls.model_construct(schema_version="ci-impact-promotion-evidence-v1", checksum="0" * 64, **values)
    return cls(checksum=draft.compute_checksum(), **values)

  @model_validator(mode="after")
  def validate_evidence(self):
    if self.passed == bool(self.blockers):
      raise ValueError("promotion result and blockers disagree")
    if self.checksum != self.compute_checksum():
      raise ValueError("promotion evidence checksum mismatch")
    return self

  def compute_checksum(self) -> str:
    payload = json.dumps(
      self.model_dump(mode="json", exclude={"checksum"}), sort_keys=True, separators=(",", ":")
    )
    return sha256(payload.encode()).hexdigest()


def build_promotion_evidence(
  *,
  report: EvaluationReport,
  policy: PromotionPolicy,
  dataset_sha256: str,
  model_checksum: str,
  job_config_sha256: str,
  workflow_sha256: str,
  required_jobs: tuple[str, ...],
  deterministic_adapter_sha256: str,
) -> CiImpactPromotionEvidence:
  blockers: list[str] = []
  if not policy.owner_approved:
    blockers.append("promotion_policy_unapproved")
  if not TRUSTED_APPROVAL_VERIFIER_AVAILABLE:
    blockers.append("trusted_owner_approval_verifier_unavailable")
  if set(report.per_job) != set(required_jobs):
    blockers.append("required_job_metrics_missing_or_job_universe_mismatch")
  if set(report.baseline_per_job) != set(report.per_job):
    blockers.append("rule_baseline_missing_or_job_universe_mismatch")
  missing_epochs = set(policy.required_epochs) - set(report.epoch_coverage)
  if missing_epochs:
    blockers.append("required_epochs_missing:" + ",".join(sorted(missing_epochs)))
  if report.abstention_coverage > policy.maximum_abstention_coverage:
    blockers.append("abstention_coverage_exceeded")
  if report.stability is None or report.stability < policy.minimum_stability:
    blockers.append("stability_below_threshold")
  for job, metrics in report.per_job.items():
    baseline = report.baseline_per_job.get(job)
    if metrics.required_support < policy.minimum_required_support:
      blockers.append(f"{job}:required_support_below_threshold")
    if metrics.safe_to_skip_support < policy.minimum_safe_to_skip_support:
      blockers.append(f"{job}:safe_to_skip_support_below_threshold")
    if metrics.required_job_recall is None or metrics.required_job_recall < policy.minimum_required_recall:
      blockers.append(f"{job}:required_job_recall_below_threshold")
    if metrics.unsafe_skip_rate is None or metrics.unsafe_skip_rate > policy.maximum_unsafe_skip_rate:
      blockers.append(f"{job}:unsafe_skip_rate_above_threshold")
    if metrics.precision is None or metrics.precision < policy.minimum_precision:
      blockers.append(f"{job}:precision_below_threshold")
    if metrics.brier_score is None or metrics.brier_score > policy.maximum_brier_score:
      blockers.append(f"{job}:brier_score_above_threshold")
    if (
      metrics.expected_calibration_error is None
      or metrics.expected_calibration_error > policy.maximum_expected_calibration_error
    ):
      blockers.append(f"{job}:calibration_error_above_threshold")
    if baseline is not None:
      if (
        baseline.required_job_recall is not None
        and (metrics.required_job_recall is None or metrics.required_job_recall < baseline.required_job_recall)
      ):
        blockers.append(f"{job}:required_job_recall_below_rule_baseline")
      if (
        baseline.unsafe_skip_rate is not None
        and (metrics.unsafe_skip_rate is None or metrics.unsafe_skip_rate > baseline.unsafe_skip_rate)
      ):
        blockers.append(f"{job}:unsafe_skip_rate_above_rule_baseline")
  evaluation_payload = json.dumps(report.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
  return CiImpactPromotionEvidence.create(
    dataset_sha256=dataset_sha256,
    model_checksum=model_checksum,
    job_config_sha256=job_config_sha256,
    workflow_sha256=workflow_sha256,
    promotion_policy_sha256=policy.checksum(),
    deterministic_adapter_sha256=deterministic_adapter_sha256,
    approval_receipt_sha256=None,
    approval_verified=False,
    evaluation_checksum=sha256(evaluation_payload.encode()).hexdigest(),
    passed=not blockers,
    blockers=tuple(blockers),
  )
