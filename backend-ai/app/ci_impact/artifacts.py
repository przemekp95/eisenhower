from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
import json
import os
from pathlib import Path
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.ci_impact.models import GIT_SHA_PATTERN, SHA256_PATTERN


CANDIDATE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{2,127}$")


class FrozenModel(BaseModel):
  model_config = ConfigDict(extra="forbid", frozen=True)


class CiImpactArtifactReference(FrozenModel):
  name: str = Field(..., min_length=1, max_length=128)
  revision: str = Field(..., min_length=1, max_length=256)
  sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  uri: str

  @model_validator(mode="after")
  def require_content_addressed_uri(self):
    if self.uri != f"ci-impact-registry://sha256/{self.sha256}":
      raise ValueError("CI impact artifact URI is not content-addressed")
    return self


class CiImpactRuntimeLineage(FrozenModel):
  name: str = Field(..., min_length=1, max_length=128)
  version: str = Field(..., min_length=1, max_length=256)
  digest: str = Field(..., pattern=SHA256_PATTERN.pattern)


class CiImpactCandidateManifest(FrozenModel):
  schema_version: Literal["ci-impact-candidate-v1"] = "ci-impact-candidate-v1"
  candidate_id: str
  created_at: datetime
  git_sha: str = Field(..., pattern=GIT_SHA_PATTERN.pattern)
  git_dirty: bool
  dataset_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  feature_schema_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  job_config_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  workflow_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  promotion_policy_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  implementation_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  deterministic_adapter_sha256: str = Field(..., pattern=SHA256_PATTERN.pattern)
  runtime: CiImpactRuntimeLineage
  model: CiImpactArtifactReference
  evaluation: CiImpactArtifactReference
  promotion_eligible: bool
  blockers: tuple[str, ...]
  checksum: str = Field(..., pattern=SHA256_PATTERN.pattern)

  @classmethod
  def create(cls, **values) -> "CiImpactCandidateManifest":
    values.setdefault("created_at", datetime.now(UTC))
    draft = cls.model_construct(schema_version="ci-impact-candidate-v1", checksum="0" * 64, **values)
    return cls(checksum=draft.compute_checksum(), **values)

  @model_validator(mode="after")
  def validate_candidate(self):
    if not CANDIDATE_PATTERN.fullmatch(self.candidate_id):
      raise ValueError("invalid CI impact candidate identifier")
    if self.created_at.tzinfo is None or self.created_at.utcoffset() is None:
      raise ValueError("candidate timestamp must be timezone-aware")
    if self.promotion_eligible == bool(self.blockers):
      raise ValueError("promotion eligibility and blockers disagree")
    if self.checksum != self.compute_checksum():
      raise ValueError("CI impact candidate checksum mismatch")
    return self

  def compute_checksum(self) -> str:
    payload = json.dumps(
      self.model_dump(mode="json", exclude={"checksum"}), sort_keys=True, separators=(",", ":")
    )
    return sha256(payload.encode()).hexdigest()


class CiImpactRegistry:
  """Private immutable namespace, deliberately separate from ai-candidate-v1."""

  def __init__(self, root: Path):
    self.root = root
    self.blobs = root / "blobs" / "sha256"
    self.manifests = root / "manifests"
    for directory in (self.root, self.blobs, self.manifests):
      directory.mkdir(parents=True, exist_ok=True, mode=0o700)
      directory.chmod(0o700)

  def register_blob(self, name: str, revision: str, payload: bytes) -> CiImpactArtifactReference:
    digest = sha256(payload).hexdigest()
    path = self.blobs / digest
    self._write_immutable(path, payload)
    return CiImpactArtifactReference(
      name=name,
      revision=revision,
      sha256=digest,
      uri=f"ci-impact-registry://sha256/{digest}",
    )

  def register_manifest(self, manifest: CiImpactCandidateManifest) -> Path:
    for reference in (manifest.model, manifest.evaluation):
      path = self.blobs / reference.sha256
      if not path.is_file() or sha256(path.read_bytes()).hexdigest() != reference.sha256:
        raise ValueError("CI impact candidate references a missing or drifted blob")
    path = self.manifest_path(manifest.candidate_id)
    payload = (manifest.model_dump_json(indent=2) + "\n").encode()
    self._write_immutable(path, payload)
    return path

  def manifest_path(self, candidate_id: str) -> Path:
    if not CANDIDATE_PATTERN.fullmatch(candidate_id):
      raise ValueError("invalid CI impact candidate identifier")
    return self.manifests / f"{candidate_id}.json"

  def load_manifest(self, candidate_id: str) -> CiImpactCandidateManifest:
    path = self.manifest_path(candidate_id)
    try:
      manifest = CiImpactCandidateManifest.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as issue:
      raise ValueError("CI impact candidate manifest is invalid") from issue
    if manifest.candidate_id != candidate_id:
      raise ValueError("CI impact candidate manifest identity mismatch")
    for reference in (manifest.model, manifest.evaluation):
      blob = self.blobs / reference.sha256
      if not blob.is_file() or sha256(blob.read_bytes()).hexdigest() != reference.sha256:
        raise ValueError("CI impact candidate blob checksum mismatch")
    return manifest

  @staticmethod
  def _write_immutable(path: Path, payload: bytes) -> None:
    try:
      descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as issue:
      if path.read_bytes() != payload:
        raise ValueError("immutable CI impact artifact conflict") from issue
      return
    try:
      remaining = memoryview(payload)
      while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
          raise OSError("immutable CI impact artifact write made no progress")
        remaining = remaining[written:]
      os.fsync(descriptor)
    finally:
      os.close(descriptor)
