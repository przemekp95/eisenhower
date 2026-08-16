from __future__ import annotations

from hashlib import sha256
import json
from typing import Callable

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from ..document_extraction.models import OCRRequest
from ..document_versions import DocumentVersionStore
from ..job_worker import PermanentJobError
from .errors import ProjectionUnavailable
from .models import AccessScope, SourceDocument


class _ExtractDocumentCommand(BaseModel):
  model_config = ConfigDict(extra="forbid")

  event_id: str = Field(..., min_length=1, max_length=256)
  tenant_id: str = Field(..., min_length=1, max_length=128)
  source: str = Field(..., min_length=1, max_length=4096)
  scope: AccessScope
  source_sequence: int = Field(..., ge=0, le=9_223_372_036_854_775_807)
  ocr: OCRRequest | None = None

  @model_validator(mode="after")
  def validate_tenant_boundary(self):
    if self.tenant_id != self.scope.tenant_id:
      raise ValueError("command tenant does not match access scope")
    return self


def canonical_checksum(value) -> str:
  serialized = json.dumps(
    value,
    sort_keys=True,
    separators=(",", ":"),
    ensure_ascii=False,
  ).encode("utf-8")
  return "sha256:" + sha256(serialized).hexdigest()


class RagJobHandlers:
  """Validated allowlisted handlers at the async ingestion boundary."""

  def __init__(
    self,
    ingestion_application,
    version_store: DocumentVersionStore | None,
    *,
    chunking_version: str,
    reindex_project: Callable[[dict], None] | None = None,
    evaluate: Callable[[dict], None] | None = None,
    extract_document=None,
  ):
    self.ingestion = ingestion_application
    self.versions = version_store
    self.chunking_version = chunking_version
    self._reindex_project = reindex_project
    self._evaluate = evaluate
    self._extract_document = extract_document

  @property
  def registry(self) -> dict[str, Callable[[dict], None]]:
    return {
      "rag.upsert": self.upsert,
      "rag.tombstone": self.tombstone,
      "rag.reindex_project": self.reindex_project,
      "rag.evaluate": self.evaluate,
      "rag.extract_document": self.extract_document,
    }

  def upsert(self, payload: dict) -> None:
    documents = payload.get("documents")
    if not isinstance(documents, list) or not documents:
      raise PermanentJobError("documents are required")
    if payload.get("embedding_version") != self.ingestion.embedding_provider.version:
      raise PermanentJobError("embedding version mismatch")
    if payload.get("chunking_version") != self.chunking_version:
      raise PermanentJobError("chunking version mismatch")
    if payload.get("content_checksum") != canonical_checksum(documents):
      raise PermanentJobError("content checksum mismatch")

    try:
      normalized = [self._source_document(payload, document) for document in documents]
    except (KeyError, TypeError, ValidationError) as error:
      raise PermanentJobError("invalid source document") from error
    source_sequence = self._source_sequence(payload)
    accepted = [
      document for document in normalized
      if self._is_newer(document.tenant_id, document.document_id, source_sequence)
    ]
    if not accepted:
      return
    result = self.ingestion.ingest(accepted)
    if result and result.get("conflict", 0):
      raise PermanentJobError("canonical source sequence conflict")
    self._require_projection_complete(result)
    for document in accepted:
      if self.versions is not None:
        self.versions.record(document.tenant_id, document.document_id, source_sequence)

  def tombstone(self, payload: dict) -> None:
    document_ids = payload.get("document_ids")
    tenant_id = payload.get("tenant_id")
    content_version = payload.get("source_version")
    if not isinstance(document_ids, list) or not document_ids or not tenant_id or not content_version:
      raise PermanentJobError("invalid tenant-scoped tombstone")
    source_sequence = self._source_sequence(payload)
    accepted = [
      str(document_id) for document_id in document_ids
      if self._is_newer(str(tenant_id), str(document_id), source_sequence)
    ]
    if not accepted:
      return
    result = self.ingestion.tombstone(
      accepted,
      tenant_id=str(tenant_id),
      content_version=str(content_version),
      source_sequence=source_sequence,
    )
    if result and result.get("conflict", 0):
      raise PermanentJobError("canonical tombstone sequence conflict")
    self._require_projection_complete(result)
    for document_id in accepted:
      if self.versions is not None:
        self.versions.record(str(tenant_id), document_id, source_sequence)

  def reindex_project(self, payload: dict) -> None:
    if self._reindex_project is None:
      raise PermanentJobError("reindex handler is not configured")
    self._reindex_project(payload)

  def evaluate(self, payload: dict) -> None:
    if self._evaluate is None:
      raise PermanentJobError("evaluation handler is not configured")
    self._evaluate(payload)

  def extract_document(self, payload: dict) -> None:
    if self._extract_document is None:
      raise PermanentJobError("document extraction handler is not configured")
    try:
      command = _ExtractDocumentCommand.model_validate(payload)
    except ValidationError as error:
      raise PermanentJobError("invalid document extraction command") from error
    result = self._extract_document.ingest(
      command.source,
      scope=command.scope,
      source_sequence=command.source_sequence,
      ocr=command.ocr,
    )
    self._require_projection_complete(result)

  @staticmethod
  def _source_document(envelope: dict, raw: dict) -> SourceDocument:
    tenant_id = str(envelope["tenant_id"])
    project_id = str(envelope["project_id"]) if envelope.get("project_id") else None
    acl = raw["acl"]
    owner_id = str(acl["owner_id"])
    reader_ids = [str(reader_id) for reader_id in acl.get("reader_ids", [])]
    acl_subjects = [f"user:{owner_id}"]
    acl_subjects.extend(f"user:{reader_id}" for reader_id in reader_ids)
    if project_id:
      acl_subjects.append(f"project:{project_id}")
    document_id = str(raw["document_id"])
    return SourceDocument(
      document_id=document_id,
      tenant_id=tenant_id,
      project_id=project_id,
      owner_id=owner_id,
      source_type=raw["source_type"],
      source_uri=str(raw.get("source_uri") or f"eisenhower://documents/{document_id}"),
      title=str(raw.get("title") or ""),
      text=str(raw["content"]),
      content_version=str(raw.get("updated_at") or envelope["source_version"]),
      source_sequence=RagJobHandlers._source_sequence(envelope),
      acl_subjects=list(dict.fromkeys(acl_subjects)),
    )

  @staticmethod
  def _source_sequence(payload: dict) -> int:
    value = payload.get("source_sequence")
    if (
      isinstance(value, bool)
      or not isinstance(value, int)
      or value < 0
      or value > 9_223_372_036_854_775_807
    ):
      raise PermanentJobError("source_sequence must fit a non-negative SQLite integer")
    return value

  def _is_newer(self, tenant_id: str, document_id: str, source_sequence: int) -> bool:
    if self.versions is None:
      return True
    current = self.versions.current(tenant_id, document_id)
    return current is None or source_sequence > current

  @staticmethod
  def _require_projection_complete(result: dict | None) -> None:
    if result and int(result.get("pending", 0)) > 0:
      raise ProjectionUnavailable("canonical projection remains pending")
