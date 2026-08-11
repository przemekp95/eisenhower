from __future__ import annotations

from datetime import datetime
from hashlib import sha256
import json
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


CHECKSUM_PATTERN = re.compile(r"^[a-f0-9]{64}$")
GIT_SHA_PATTERN = re.compile(r"^[a-f0-9]{40}$")
CANDIDATE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{2,127}$")


class FrozenModel(BaseModel):
  model_config = ConfigDict(extra="forbid", frozen=True)


class ArtifactReference(FrozenModel):
  name: str = Field(..., min_length=1, max_length=128)
  revision: str = Field(..., min_length=1, max_length=256)
  sha256: str = Field(..., pattern=CHECKSUM_PATTERN.pattern)
  uri: str = Field(..., min_length=1, max_length=512)

  @model_validator(mode="after")
  def require_content_addressed_registry_uri(self):
    if self.uri != f"registry://sha256/{self.sha256}":
      raise ValueError("artifact URI must be the private content-addressed registry URI")
    return self


class LineageGroup(FrozenModel):
  items: tuple[ArtifactReference, ...] = ()
  not_applicable_reason: str | None = Field(default=None, min_length=8, max_length=500)

  @model_validator(mode="after")
  def require_items_or_explicit_gap(self):
    if bool(self.items) == bool(self.not_applicable_reason):
      raise ValueError("lineage group requires items or not_applicable_reason, but not both")
    identities = {(item.name, item.revision, item.sha256) for item in self.items}
    if len(identities) != len(self.items):
      raise ValueError("lineage group contains duplicate artifact references")
    return self


class GitLineage(FrozenModel):
  commit_sha: str = Field(..., pattern=GIT_SHA_PATTERN.pattern)
  dirty: bool


class RuntimeLineage(FrozenModel):
  name: str = Field(..., min_length=1, max_length=128)
  version: str = Field(..., min_length=1, max_length=256)
  digest: str = Field(..., pattern=CHECKSUM_PATTERN.pattern)


class CandidateManifest(FrozenModel):
  manifest_version: Literal["ai-candidate-v1"] = "ai-candidate-v1"
  candidate_id: str = Field(..., min_length=3, max_length=128)
  workflow: Literal["mlops", "ragops", "llmops", "monitoring", "promotion"]
  status: Literal["candidate"] = "candidate"
  evidence_level: Literal[
    "local_mock",
    "local_in_process",
    "local_live_dependency",
    "ci_in_process",
    "ci_live_dependency",
    "live_model",
  ]
  created_at: datetime
  git: GitLineage
  datasets: LineageGroup
  models: LineageGroup
  prompts: LineageGroup
  schemas: LineageGroup
  corpora: LineageGroup
  qdrant_collections: LineageGroup
  runtimes: tuple[RuntimeLineage, ...] = Field(..., min_length=1)
  reports: LineageGroup
  manifest_checksum: str = Field(..., pattern=CHECKSUM_PATTERN.pattern)

  @classmethod
  def create(cls, **values) -> "CandidateManifest":
    draft = cls.model_construct(
      manifest_version="ai-candidate-v1",
      status="candidate",
      manifest_checksum="0" * 64,
      **values,
    )
    return cls(manifest_checksum=draft.compute_checksum(), **values)

  @model_validator(mode="after")
  def validate_identity_and_checksum(self):
    if not CANDIDATE_ID_PATTERN.fullmatch(self.candidate_id):
      raise ValueError("candidate_id must be a safe lowercase artifact identifier")
    if self.created_at.tzinfo is None or self.created_at.utcoffset() is None:
      raise ValueError("created_at must be timezone-aware")
    runtime_identities = {(runtime.name, runtime.version, runtime.digest) for runtime in self.runtimes}
    if len(runtime_identities) != len(self.runtimes):
      raise ValueError("runtime lineage contains duplicate entries")
    if self.manifest_checksum != self.compute_checksum():
      raise ValueError("manifest checksum does not match canonical lineage")
    return self

  def canonical_payload(self) -> dict:
    return self.model_dump(mode="json", exclude={"manifest_checksum"})

  def canonical_json(self) -> str:
    return json.dumps(
      self.canonical_payload(), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )

  def compute_checksum(self) -> str:
    return sha256(self.canonical_json().encode("utf-8")).hexdigest()

  def verify_checksum(self) -> bool:
    return self.manifest_checksum == self.compute_checksum()

  def artifact_references(self) -> tuple[ArtifactReference, ...]:
    groups = (
      self.datasets,
      self.models,
      self.prompts,
      self.schemas,
      self.corpora,
      self.qdrant_collections,
      self.reports,
    )
    return tuple(reference for group in groups for reference in group.items)
