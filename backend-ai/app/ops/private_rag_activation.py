from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.artifacts.registry import ArtifactConflictError, write_private_bytes


APPROVED_TENANT = "eisenhower-owner"
APPROVED_PROJECTS = ("eisenhower",)
APPROVED_RESPONSE_USERS = ("f226f9de-1c01-4a36-9eb3-77f3313e3456",)
AUTOMATED_APPROVERS = {"automation", "bot", "ci", "self", "system", "unknown"}
SHA256_PATTERN = r"^[a-f0-9]{64}$"
GIT_SHA_PATTERN = r"^[a-f0-9]{40}$"
IMAGE_DIGEST_PATTERN = r"^.+@sha256:[a-f0-9]{64}$"


class ActivationBlocked(ValueError):
  """Raised when private RAG activation evidence is incomplete or drifted."""


class _StrictModel(BaseModel):
  model_config = ConfigDict(extra="forbid")


class DisabledMemoryFlags(_StrictModel):
  write: Literal[False]
  retrieval: Literal[False]
  response: Literal[False]


class RuntimeModelIdentity(_StrictModel):
  name: str = Field(min_length=1, max_length=256)
  revision: str = Field(pattern=GIT_SHA_PATTERN)
  image_digest: str = Field(pattern=IMAGE_DIGEST_PATTERN)


class EmbeddingModelIdentity(_StrictModel):
  name: str = Field(min_length=1, max_length=256)
  revision: str = Field(pattern=GIT_SHA_PATTERN)


class PrivateRagModels(_StrictModel):
  generator: RuntimeModelIdentity
  reranker: RuntimeModelIdentity
  embedding: EmbeddingModelIdentity


class PrivateRagStopThresholds(_StrictModel):
  maximum_p95_seconds: float = Field(gt=0, le=120)
  maximum_error_rate: float = Field(ge=0, le=0.25)
  maximum_circuit_open_events: int = Field(ge=0, le=10)
  minimum_citation_validity: float = Field(ge=0.95, le=1)
  minimum_no_answer_precision: float = Field(ge=0.95, le=1)
  minimum_no_answer_recall: float = Field(ge=0.95, le=1)


class PrivateRagRollback(_StrictModel):
  primary_project: Literal["eisenhower-e2eff0"]
  primary_loopback: Literal["127.0.0.1:8990"]
  secondary_project: Literal["eisenhower-ddb83c"]
  secondary_loopback: Literal["127.0.0.1:8890"]


class OwnerPrivateRagApproval(_StrictModel):
  schema_version: Literal["private-rag-owner-approval-v1"]
  approved_by: str = Field(min_length=1, max_length=128)
  approved_at: datetime
  valid_until: datetime
  decision: Literal["activate_private_single_turn_grounded_response"]
  source_git_sha: str = Field(pattern=GIT_SHA_PATTERN)
  corpus_manifest_sha256: str = Field(pattern=SHA256_PATTERN)
  corpus_snapshot_sha256: str = Field(pattern=SHA256_PATTERN)
  ragops_report_sha256: str = Field(pattern=SHA256_PATTERN)
  answer_report_sha256: str = Field(pattern=SHA256_PATTERN)
  tenant_id: str
  project_ids: tuple[str, ...]
  response_users: tuple[str, ...]
  collection: str = Field(min_length=1, max_length=128)
  canonical_document_count: int = Field(gt=0)
  projection_point_count: int = Field(gt=0)
  models: PrivateRagModels
  prompt_version: str = Field(min_length=1, max_length=64)
  knowledge_prompt_version: str = Field(min_length=1, max_length=64)
  stop_thresholds: PrivateRagStopThresholds
  rollback: PrivateRagRollback
  memory: DisabledMemoryFlags
  mag_mode: Literal["disabled"]
  public_release_authorized: Literal[False]


class PrivateRagActivationReceipt(_StrictModel):
  schema_version: Literal["private-rag-activation-v1"]
  source_git_sha: str = Field(pattern=GIT_SHA_PATTERN)
  generated_at: datetime
  approved_by: str
  approved_at: datetime
  valid_until: datetime
  approval_sha256: str = Field(pattern=SHA256_PATTERN)
  corpus_manifest_sha256: str = Field(pattern=SHA256_PATTERN)
  corpus_snapshot_sha256: str = Field(pattern=SHA256_PATTERN)
  ragops_report_sha256: str = Field(pattern=SHA256_PATTERN)
  answer_report_sha256: str = Field(pattern=SHA256_PATTERN)
  tenant_id: Literal["eisenhower-owner"]
  project_ids: tuple[Literal["eisenhower"], ...]
  response_users: tuple[Literal["f226f9de-1c01-4a36-9eb3-77f3313e3456"], ...]
  collection: str
  canonical_document_count: int
  projection_point_count: int
  models: PrivateRagModels
  prompt_version: str
  knowledge_prompt_version: str
  stop_thresholds: PrivateRagStopThresholds
  rollback: PrivateRagRollback
  memory: DisabledMemoryFlags
  mag_mode: Literal["disabled"]
  public_release_authorized: Literal[False]


@dataclass(frozen=True)
class PrivateRagActivationInputs:
  approval: Path
  corpus_manifest: Path
  corpus_snapshot: Path
  ragops_report: Path
  answer_report: Path
  source_git_sha: str
  git_dirty: bool


def _digest(path: Path, label: str) -> str:
  try:
    return sha256(path.read_bytes()).hexdigest()
  except OSError as issue:
    raise ActivationBlocked(f"{label} is unavailable") from issue


def _utc(value: datetime, label: str) -> datetime:
  if value.tzinfo is None or value.utcoffset() is None:
    raise ActivationBlocked(f"{label} must include a timezone")
  return value.astimezone(UTC)


def _load_approval(path: Path) -> tuple[OwnerPrivateRagApproval, str]:
  try:
    raw = path.read_bytes()
    approval = OwnerPrivateRagApproval.model_validate_json(raw)
  except (OSError, ValidationError) as issue:
    raise ActivationBlocked(f"owner approval is invalid: {issue}") from issue
  return approval, sha256(raw).hexdigest()


def build_private_rag_activation(
  inputs: PrivateRagActivationInputs,
  *,
  now: datetime | None = None,
) -> PrivateRagActivationReceipt:
  if inputs.git_dirty:
    raise ActivationBlocked("private RAG activation requires a clean Git tree")
  if not __import__("re").fullmatch(GIT_SHA_PATTERN, inputs.source_git_sha):
    raise ActivationBlocked("source Git SHA is invalid")

  approval, approval_digest = _load_approval(inputs.approval)
  checked_at = _utc(now or datetime.now(UTC), "current time")
  approved_at = _utc(approval.approved_at, "approved_at")
  valid_until = _utc(approval.valid_until, "valid_until")
  if approved_at > checked_at + timedelta(minutes=5):
    raise ActivationBlocked("approval timestamp is in the future")
  if checked_at >= valid_until:
    raise ActivationBlocked("owner approval has expired")
  if valid_until - approved_at > timedelta(days=30):
    raise ActivationBlocked("owner approval may not exceed thirty days")
  if approval.approved_by.strip().casefold() in AUTOMATED_APPROVERS:
    raise ActivationBlocked("owner approval requires a named human owner")
  if approval.source_git_sha != inputs.source_git_sha:
    raise ActivationBlocked("owner approval source Git SHA mismatch")
  if approval.tenant_id != APPROVED_TENANT:
    raise ActivationBlocked("owner approval tenant is not allowlisted")
  if approval.project_ids != APPROVED_PROJECTS:
    raise ActivationBlocked("owner approval project scope is not allowlisted")
  if approval.response_users != APPROVED_RESPONSE_USERS:
    raise ActivationBlocked("owner approval response user scope is not allowlisted")
  if not approval.collection.endswith("-candidate"):
    raise ActivationBlocked("owner approval collection must remain an isolated candidate")
  if approval.models.generator.image_digest != approval.models.reranker.image_digest:
    raise ActivationBlocked("generator and reranker must use the same scanned response image")

  actual_digests = {
    "corpus manifest": _digest(inputs.corpus_manifest, "corpus manifest"),
    "corpus snapshot": _digest(inputs.corpus_snapshot, "corpus snapshot"),
    "RAGOps report": _digest(inputs.ragops_report, "RAGOps report"),
    "answer report": _digest(inputs.answer_report, "answer report"),
  }
  expected_digests = {
    "corpus manifest": approval.corpus_manifest_sha256,
    "corpus snapshot": approval.corpus_snapshot_sha256,
    "RAGOps report": approval.ragops_report_sha256,
    "answer report": approval.answer_report_sha256,
  }
  drift = [label for label, digest in actual_digests.items() if digest != expected_digests[label]]
  if drift:
    raise ActivationBlocked(f"bound input digest mismatch: {', '.join(drift)}")

  return PrivateRagActivationReceipt(
    schema_version="private-rag-activation-v1",
    source_git_sha=inputs.source_git_sha,
    generated_at=checked_at,
    approved_by=approval.approved_by,
    approved_at=approved_at,
    valid_until=valid_until,
    approval_sha256=approval_digest,
    corpus_manifest_sha256=approval.corpus_manifest_sha256,
    corpus_snapshot_sha256=approval.corpus_snapshot_sha256,
    ragops_report_sha256=approval.ragops_report_sha256,
    answer_report_sha256=approval.answer_report_sha256,
    tenant_id=approval.tenant_id,
    project_ids=approval.project_ids,
    response_users=approval.response_users,
    collection=approval.collection,
    canonical_document_count=approval.canonical_document_count,
    projection_point_count=approval.projection_point_count,
    models=approval.models,
    prompt_version=approval.prompt_version,
    knowledge_prompt_version=approval.knowledge_prompt_version,
    stop_thresholds=approval.stop_thresholds,
    rollback=approval.rollback,
    memory=approval.memory,
    mag_mode=approval.mag_mode,
    public_release_authorized=approval.public_release_authorized,
  )


def write_private_rag_activation(
  receipt: PrivateRagActivationReceipt,
  private_path: Path,
  commitment_path: Path,
) -> None:
  if private_path.exists() or commitment_path.exists():
    raise ActivationBlocked("activation evidence already exists")
  private_bytes = (receipt.model_dump_json(indent=2) + "\n").encode("utf-8")
  commitment = {
    "schema_version": "private-rag-activation-commitment-v1",
    "source_git_sha": receipt.source_git_sha,
    "receipt_sha256": sha256(private_bytes).hexdigest(),
  }
  commitment_bytes = (
    json.dumps(commitment, sort_keys=True, separators=(",", ":")) + "\n"
  ).encode("utf-8")
  try:
    write_private_bytes(private_path, private_bytes)
    write_private_bytes(commitment_path, commitment_bytes)
  except ArtifactConflictError as issue:
    raise ActivationBlocked("activation evidence already exists") from issue
