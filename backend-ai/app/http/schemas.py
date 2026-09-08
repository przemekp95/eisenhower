from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..document_extraction.models import OCRRequest
from ..generation.models import KnownStatement
from ..rag.models import AccessScope, Citation, RetrievalSummary


MAX_TASK_LENGTH = 500
MAX_BATCH_TASKS = 100


class StrictRequest(BaseModel):
  model_config = ConfigDict(extra="forbid")


class RagAnalyzeRequest(StrictRequest):
  task: str = Field(..., min_length=1, max_length=MAX_TASK_LENGTH)
  language: Literal["en", "pl"] = "en"
  known_state: list[KnownStatement] | None = Field(default=None, max_length=40)
  previous_output_statements: list[KnownStatement] | None = Field(default=None, max_length=40)
  freshness_requirement: Literal["snapshot_sufficient", "current_world_required"] = (
    "snapshot_sufficient"
  )

  @model_validator(mode="after")
  def statement_ids_are_globally_unique(self):
    statements = (self.known_state or []) + (self.previous_output_statements or [])
    identifiers = [item.statement_id for item in statements]
    if len(identifiers) != len(set(identifiers)):
      raise ValueError("known and previous-output statement ids must be globally unique")
    return self


class ClassifyRequest(StrictRequest):
  title: str = Field(..., min_length=1, max_length=MAX_TASK_LENGTH)
  use_rag: bool = True


class AnalyzeRequest(StrictRequest):
  task: str = Field(..., min_length=1, max_length=MAX_TASK_LENGTH)
  language: Literal["en", "pl"] = "en"


class KnowledgeSearchRequest(StrictRequest):
  query: str = Field(..., min_length=1, max_length=2000)
  project_id: str | None = Field(default=None, max_length=128)
  limit: int = Field(default=5, ge=1, le=20)


class KnowledgeSearchResponse(StrictRequest):
  query: str
  answer: str | None = None
  citations: list[Citation] = Field(default_factory=list)
  retrieval: RetrievalSummary = Field(default_factory=RetrievalSummary)
  no_answer_reason: str | None = None


class KnowledgeAnswerApiRequest(StrictRequest):
  query: str = Field(..., min_length=1, max_length=2000)
  language: Literal["en", "pl"] = "en"
  project_id: str | None = Field(default=None, max_length=128)
  limit: int = Field(default=5, ge=1, le=20)


class InternalJobRequest(StrictRequest):
  event_id: str = Field(..., min_length=1, max_length=128)
  tenant_id: str = Field(..., min_length=1, max_length=128)
  project_id: str | None = Field(default=None, max_length=128)
  source_version: str = Field(..., min_length=1, max_length=128)
  source_sequence: int = Field(..., ge=0, le=9_223_372_036_854_775_807)
  content_checksum: str = Field(..., pattern=r"^sha256:[a-f0-9]{64}$")
  embedding_version: str = Field(..., min_length=1, max_length=128)
  chunking_version: str = Field(..., min_length=1, max_length=128)
  documents: list[dict] | None = Field(default=None, max_length=500)
  document_ids: list[str] | None = Field(default=None, max_length=5000)
  dataset_version: str | None = Field(default=None, max_length=128)


class InternalExtractionJobRequest(StrictRequest):
  event_id: str = Field(..., min_length=1, max_length=128)
  tenant_id: str = Field(..., min_length=1, max_length=128)
  source: str = Field(..., min_length=1, max_length=4096)
  scope: AccessScope
  source_sequence: int = Field(..., ge=0, le=9_223_372_036_854_775_807)
  ocr: OCRRequest | None = None

  @model_validator(mode="after")
  def scope_must_match_envelope_tenant(self):
    if self.tenant_id != self.scope.tenant_id:
      raise ValueError("envelope tenant does not match access scope")
    return self


class BatchRequest(StrictRequest):
  tasks: list[str] = Field(default_factory=list, max_length=MAX_BATCH_TASKS)


class ProviderStateRequest(StrictRequest):
  enabled: bool


class OCRAcceptedTask(StrictRequest):
  task: str = Field(..., min_length=1, max_length=MAX_TASK_LENGTH)
  quadrant: int = Field(..., ge=0, le=3)


class OCRFeedbackRequest(StrictRequest):
  tasks: list[OCRAcceptedTask] = Field(default_factory=list, max_length=MAX_BATCH_TASKS)
  retrain: bool = True
