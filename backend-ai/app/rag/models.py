from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..generation.models import GenerationResult


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


class SourceDocument(StrictModel):
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
  content_version: str
  source_sequence: int = Field(default=0, ge=0, le=9_223_372_036_854_775_807)
  acl_subjects: list[str]
  deleted: bool = False


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
  acl_subjects: list[str]
  deleted: bool = False
