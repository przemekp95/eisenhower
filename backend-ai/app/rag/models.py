from __future__ import annotations

from hashlib import sha256
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..generation.models import (
  GenerationResult,
  InformationDelta,
  KnowledgeAnswerClaim,
  KnownStatement,
)


class StrictModel(BaseModel):
  model_config = ConfigDict(extra="forbid")


class AccessScope(StrictModel):
  tenant_id: str = Field(..., min_length=1, max_length=128)
  user_id: str = Field(..., min_length=1, max_length=128)
  project_ids: list[str] = Field(default_factory=list, max_length=100)
  roles: list[str] = Field(default_factory=list, max_length=20)

  @property
  def acl_subjects(self) -> list[str]:
    subjects = [f"tenant:{self.tenant_id}", f"user:{self.user_id}"]
    subjects.extend(f"project:{project_id}" for project_id in self.project_ids)
    subjects.extend(f"role:{role}" for role in self.roles)
    return subjects


class RetrievalQuery(StrictModel):
  text: str = Field(..., min_length=1, max_length=2000)
  scope: AccessScope
  project_id: str | None = Field(default=None, min_length=1, max_length=128)
  limit: int = Field(default=6, ge=1, le=20)
  score_threshold: float = Field(default=0.2, ge=-1.0, le=1.0)


class RetrievalHit(StrictModel):
  chunk_id: str
  document_id: str
  text: str
  score: float
  source_uri: str
  title: str
  tenant_id: str
  project_id: str | None = None
  owner_id: str | None = None
  embedding_version: str
  content_version: str
  source_type: str = "knowledge"


class GenerationRequest(StrictModel):
  task: str
  context: list[RetrievalHit]
  language: Literal["pl", "en"] = "en"
  retrieval_version: str = "retrieval-v1"
  index_version: str = "index-v1"
  allowed_quadrants: list[int] = [0, 1, 2, 3]
  known_state: list[KnownStatement] | None = Field(default=None, max_length=40)
  previous_output_statements: list[KnownStatement] | None = Field(default=None, max_length=40)
  freshness_requirement: Literal["snapshot_sufficient", "current_world_required"] = (
    "snapshot_sufficient"
  )

  @property
  def delta_requested(self) -> bool:
    return (
      self.known_state is not None
      or self.previous_output_statements is not None
      or self.freshness_requirement == "current_world_required"
    )

  def model_post_init(self, _context) -> None:
    statements = (self.known_state or []) + (self.previous_output_statements or [])
    identifiers = [item.statement_id for item in statements]
    if len(identifiers) != len(set(identifiers)):
      raise ValueError("known and previous-output statement ids must be globally unique")


class KnowledgeAnswerRequest(StrictModel):
  task: str = Field(..., min_length=1, max_length=2000)
  context: list[RetrievalHit]
  language: Literal["pl", "en"] = "en"
  retrieval_version: str = "retrieval-v1"
  index_version: str = "index-v1"
  known_state: None = None
  previous_output_statements: None = None
  freshness_requirement: Literal["snapshot_sufficient"] = "snapshot_sufficient"

  @property
  def delta_requested(self) -> bool:
    return False


class Citation(StrictModel):
  chunk_id: str
  document_id: str
  source_uri: str
  title: str
  excerpt: str
  score: float
  content_version: str


class RetrievalSummary(StrictModel):
  hit_count: int = 0
  top_score: float | None = None
  embedding_version: str | None = None


class GenerationMetadata(StrictModel):
  execution_id: str = Field(..., pattern=r"^[a-f0-9]{64}$")
  prompt_id: str
  prompt_version: str
  model_id: str
  model_revision: str
  schema_version: str
  language: Literal["pl", "en"]
  input_tokens: int = Field(..., ge=0)


class AnalyzeResult(StrictModel):
  mode: Literal["rag", "fallback", "no_answer"]
  quadrant: int | None = Field(default=None, ge=0, le=3)
  quadrant_name: str | None = None
  confidence: float | None = Field(default=None, ge=0.0, le=1.0)
  explanation: str
  citations: list[Citation] = Field(default_factory=list)
  retrieval: RetrievalSummary = Field(default_factory=RetrievalSummary)
  generation: GenerationMetadata | None = None
  fallback_reason: str | None = None
  information_delta: InformationDelta | None = None


class KnowledgeAnswerResponse(StrictModel):
  status: Literal["answered", "insufficient_evidence"]
  answer: str | None = None
  claims: list[KnowledgeAnswerClaim] = Field(default_factory=list)
  citations: list[Citation] = Field(default_factory=list)
  retrieval: RetrievalSummary = Field(default_factory=RetrievalSummary)
  generation: GenerationMetadata | None = None
  no_answer_reason: str | None = None


class SourceDocument(StrictModel):
  schema_version: str = "2"
  document_id: str
  tenant_id: str
  project_id: str | None = None
  owner_id: str | None = None
  source_type: Literal[
    "task",
    "project",
    "project_context",
    "knowledge",
    "decision",
    "procedure",
    "note",
    "runbook",
    "calendar_event",
  ]
  source_uri: str
  title: str
  text: str
  source_revision: str | None = None
  content_version: str
  content_checksum: str | None = None
  source_sequence: int = Field(default=0, ge=0, le=9_223_372_036_854_775_807)
  normalization_version: str = "unicode-nfc-lines-v1"
  chunking_version: str = "llama-sentence-256-32-v1"
  extraction_contract_version: str | None = None
  extraction_checksum: str | None = None
  extractor_name: str | None = None
  extractor_version: str | None = None
  ocr_approval_id: str | None = None
  prompt_injection_detected: bool = False
  acl_subjects: list[str]
  deleted: bool = False

  def model_post_init(self, _context) -> None:
    expected_checksum = sha256(self.text.encode("utf-8")).hexdigest()
    if self.content_checksum is None:
      self.content_checksum = expected_checksum
    elif self.content_checksum != expected_checksum:
      raise ValueError("content_checksum must match the canonical document text")


class ChunkRecord(StrictModel):
  chunk_id: str
  document_id: str
  tenant_id: str
  project_id: str | None = None
  owner_id: str | None = None
  source_type: str
  source_uri: str
  title: str
  text: str
  position: int
  checksum: str
  content_version: str
  source_sequence: int = Field(default=0, ge=0, le=9_223_372_036_854_775_807)
  embedding_version: str
  extraction_contract_version: str | None = None
  extraction_checksum: str | None = None
  extractor_name: str | None = None
  extractor_version: str | None = None
  ocr_approval_id: str | None = None
  prompt_injection_detected: bool = False
  acl_subjects: list[str]
  deleted: bool = False
