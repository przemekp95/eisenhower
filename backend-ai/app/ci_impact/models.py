from __future__ import annotations

from datetime import datetime
from hashlib import sha256
import json
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
GIT_SHA_PATTERN = re.compile(r"^[a-f0-9]{40}$")
SAFE_JOB_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,127}$")
ChangeStatus = Literal["added", "modified", "deleted", "renamed", "copied"]
LabelValue = Literal["required", "safe_to_skip", "unknown"]


class FrozenModel(BaseModel):
  model_config = ConfigDict(extra="forbid", frozen=True)


def _safe_relative_path(value: str) -> str:
  if not value or value.startswith(("/", "\\")) or "\x00" in value:
    raise ValueError("path must be a non-empty relative repository path")
  parts = value.replace("\\", "/").split("/")
  if any(part in {"", ".", ".."} for part in parts):
    raise ValueError("path contains an unsafe segment")
  if any(any(ord(character) < 32 for character in part) for part in parts):
    raise ValueError("path contains control characters")
  return "/".join(parts)


class ChangeFile(FrozenModel):
  path: str = Field(..., min_length=1, max_length=1024)
  previous_path: str | None = Field(default=None, max_length=1024)
  status: ChangeStatus
  additions: int = Field(default=0, ge=0, le=10_000_000)
  deletions: int = Field(default=0, ge=0, le=10_000_000)
  binary: bool = False

  @field_validator("path", "previous_path")
  @classmethod
  def validate_path(cls, value: str | None):
    return _safe_relative_path(value) if value is not None else value

  @model_validator(mode="after")
  def validate_rename_contract(self):
    if self.status in {"renamed", "copied"} and self.previous_path is None:
      raise ValueError("rename and copy records require previous_path")
    if self.status not in {"renamed", "copied"} and self.previous_path is not None:
      raise ValueError("previous_path is only valid for rename or copy records")
    return self


class ChangeSet(FrozenModel):
  schema_version: Literal["ci-impact-change-set-v1"] = "ci-impact-change-set-v1"
  base_sha: str = Field(..., pattern=GIT_SHA_PATTERN.pattern)
  head_sha: str = Field(..., pattern=GIT_SHA_PATTERN.pattern)
  files: tuple[ChangeFile, ...] = Field(..., min_length=1, max_length=5000)

  @model_validator(mode="after")
  def require_distinct_files_and_revisions(self):
    if self.base_sha == self.head_sha:
      raise ValueError("base_sha and head_sha must differ")
    identities = {(item.path, item.previous_path) for item in self.files}
    if len(identities) != len(self.files):
      raise ValueError("change set contains duplicate file identities")
    return self


class JobLabel(FrozenModel):
  value: LabelValue
  provenance: Literal["manual_review", "manual_adjudication", "manual_review_required"]
  reviewer_id: str | None = Field(default=None, min_length=3, max_length=128)
  evidence: str | None = Field(default=None, min_length=3, max_length=500)

  @model_validator(mode="after")
  def require_reviewer_for_decision(self):
    if self.value == "unknown":
      if self.provenance != "manual_review_required":
        raise ValueError("unknown labels must remain queued for manual review")
    elif self.provenance == "manual_review_required" or not self.reviewer_id or not self.evidence:
      raise ValueError("required and safe-to-skip labels need reviewer and evidence")
    return self


class JobObservation(FrozenModel):
  name: str
  conclusion: Literal[
    "success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral", "unknown"
  ]
  run_id: int | None = Field(default=None, ge=1)
  attempt: int | None = Field(default=None, ge=1)

  @field_validator("name")
  @classmethod
  def validate_job_name(cls, value: str):
    if not SAFE_JOB_PATTERN.fullmatch(value):
      raise ValueError("job name is outside the canonical allowlist syntax")
    return value


class HistoryRecord(FrozenModel):
  schema_version: Literal["ci-impact-history-record-v1"] = "ci-impact-history-record-v1"
  pull_request_number: int = Field(..., ge=1)
  merged_at: datetime
  changes: ChangeSet
  job_results: tuple[JobObservation, ...]
  labels: dict[str, JobLabel]
  workflow_sha: str | None = Field(default=None, pattern=GIT_SHA_PATTERN.pattern)

  @model_validator(mode="after")
  def validate_job_identities(self):
    if self.merged_at.tzinfo is None or self.merged_at.utcoffset() is None:
      raise ValueError("merged_at must be timezone-aware")
    identities = {(item.name, item.run_id, item.attempt) for item in self.job_results}
    if len(identities) != len(self.job_results):
      raise ValueError("job observations contain duplicate attempts")
    if any(not SAFE_JOB_PATTERN.fullmatch(name) for name in self.labels):
      raise ValueError("label contains an invalid job identifier")
    return self


class DatasetReceipt(FrozenModel):
  schema_version: Literal["ci-impact-dataset-v1"] = "ci-impact-dataset-v1"
  record_count: int = Field(..., ge=0)
  sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  labeled_required: int = Field(..., ge=0)
  labeled_safe_to_skip: int = Field(..., ge=0)
  unknown: int = Field(..., ge=0)


class JobConfig(FrozenModel):
  schema_version: Literal["ci-impact-jobs-v1"] = "ci-impact-jobs-v1"
  all_jobs: tuple[str, ...] = Field(..., min_length=1)
  required_context_jobs: tuple[str, ...] = Field(..., min_length=1)
  deterministic_jobs: tuple[str, ...] = Field(..., min_length=1)
  probability_thresholds: dict[str, float]
  known_path_prefixes: tuple[str, ...] = Field(..., min_length=1)
  rule_paths: dict[str, tuple[str, ...]]

  @model_validator(mode="after")
  def validate_job_universe(self):
    if len(set(self.all_jobs)) != len(self.all_jobs):
      raise ValueError("all_jobs contains duplicates")
    if any(not SAFE_JOB_PATTERN.fullmatch(job) for job in self.all_jobs):
      raise ValueError("all_jobs contains an unsafe job identifier")
    universe = set(self.all_jobs)
    if not set(self.required_context_jobs).issubset(universe):
      raise ValueError("required_context_jobs must be a subset of all_jobs")
    if not set(self.deterministic_jobs).issubset(universe):
      raise ValueError("deterministic_jobs must be a subset of all_jobs")
    if set(self.probability_thresholds) != universe:
      raise ValueError("probability thresholds must cover the exact job universe")
    if any(not 0 < threshold < 1 for threshold in self.probability_thresholds.values()):
      raise ValueError("probability thresholds must be between zero and one")
    if any(not set(jobs).issubset(universe) for jobs in self.rule_paths.values()):
      raise ValueError("rule path maps to an unknown job")
    if len(set(self.known_path_prefixes)) != len(self.known_path_prefixes):
      raise ValueError("known path prefixes contain duplicates")
    for prefix in self.known_path_prefixes:
      if not prefix.endswith("/") or len(prefix) > 256:
        raise ValueError("known path prefix must be a bounded directory prefix")
      if _safe_relative_path(prefix[:-1]) + "/" != prefix:
        raise ValueError("known path prefix is not normalized")
    for prefix, jobs in self.rule_paths.items():
      if not prefix.endswith("/") or len(prefix) > 256:
        raise ValueError("rule path must be a bounded directory prefix")
      if _safe_relative_path(prefix[:-1]) + "/" != prefix:
        raise ValueError("rule path is not normalized")
      if not any(prefix.startswith(known) for known in self.known_path_prefixes):
        raise ValueError("rule path is outside known path prefixes")
      if not jobs or len(set(jobs)) != len(jobs):
        raise ValueError("rule path jobs must be non-empty and unique")
    return self

  def checksum(self) -> str:
    payload = json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return sha256(payload.encode()).hexdigest()

  @property
  def classifier_jobs(self) -> tuple[str, ...]:
    deterministic = set(self.deterministic_jobs)
    return tuple(job for job in self.all_jobs if job not in deterministic)


class DeterministicTargetAdapter(FrozenModel):
  schema_version: Literal["ci-impact-deterministic-adapter-v1"] = "ci-impact-deterministic-adapter-v1"
  plan_version: Literal["ci-impact-plan/v1"] = "ci-impact-plan/v1"
  target_to_jobs: dict[str, tuple[str, ...]]

  @model_validator(mode="after")
  def validate_mapping(self):
    if not self.target_to_jobs or any(not SAFE_JOB_PATTERN.fullmatch(target) for target in self.target_to_jobs):
      raise ValueError("deterministic adapter contains an invalid target")
    if any(not jobs or any(not SAFE_JOB_PATTERN.fullmatch(job) for job in jobs) for jobs in self.target_to_jobs.values()):
      raise ValueError("deterministic adapter contains invalid job mappings")
    return self

  def checksum(self) -> str:
    payload = json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return sha256(payload.encode()).hexdigest()

  def jobs_for(self, targets: tuple[str, ...], config: JobConfig) -> tuple[str, ...]:
    if any(target not in self.target_to_jobs for target in targets):
      raise ValueError("deterministic plan contains an unknown target")
    mapped = tuple(dict.fromkeys(
      job for target in targets for job in self.target_to_jobs[target]
    ))
    if not set(mapped).issubset(config.all_jobs):
      raise ValueError("deterministic adapter maps outside the canonical job universe")
    return tuple(job for job in config.all_jobs if job in set(mapped))


class FeatureVector(FrozenModel):
  schema_version: Literal["ci-impact-features-v1"] = "ci-impact-features-v1"
  values: dict[str, float]
  unknown_paths: tuple[str, ...] = ()
  dependency_impacts: tuple[str, ...] = ()
  checksum: str = Field(..., pattern=SHA256_PATTERN.pattern)

  @classmethod
  def create(cls, **values) -> "FeatureVector":
    payload = {
      "schema_version": "ci-impact-features-v1",
      "values": values["values"],
      "unknown_paths": values.get("unknown_paths", ()),
      "dependency_impacts": values.get("dependency_impacts", ()),
    }
    checksum = sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return cls(checksum=checksum, **values)


class ShadowPlan(FrozenModel):
  schema_version: Literal["ci-impact-shadow-plan-v1"] = "ci-impact-shadow-plan-v1"
  mode: Literal["shadow"] = "shadow"
  probabilities: dict[str, float]
  canonical_jobs: tuple[str, ...]
  deterministic_jobs: tuple[str, ...]
  classifier_jobs: tuple[str, ...]
  effective_jobs: tuple[str, ...]
  abstain: bool
  full_ci: bool
  reasons: tuple[str, ...]
  model_checksum: str | None = Field(default=None, pattern=SHA256_PATTERN.pattern)

  @model_validator(mode="after")
  def enforce_additive_contract(self):
    universe = set(self.canonical_jobs)
    if len(universe) != len(self.canonical_jobs) or any(
      not SAFE_JOB_PATTERN.fullmatch(job) for job in self.canonical_jobs
    ):
      raise ValueError("canonical jobs must be unique safe identifiers")
    if not set((*self.deterministic_jobs, *self.classifier_jobs, *self.probabilities)).issubset(universe):
      raise ValueError("shadow plan contains a job outside the canonical universe")
    expected = tuple(dict.fromkeys((*self.deterministic_jobs, *self.classifier_jobs)))
    if self.full_ci and self.effective_jobs != self.canonical_jobs:
      raise ValueError("full CI must contain the exact canonical job universe")
    if not self.full_ci and self.effective_jobs != expected:
      raise ValueError("effective jobs must be deterministic_jobs UNION classifier_jobs")
    if self.abstain != self.full_ci:
      raise ValueError("abstention must fail open to full CI")
    return self
