from __future__ import annotations

from hashlib import sha256
import json
from typing import Callable

from pydantic import ValidationError

from ..job_worker import PermanentJobError
from .models import SourceDocument


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
    *,
    chunking_version: str,
    reindex_project: Callable[[dict], None] | None = None,
    evaluate: Callable[[dict], None] | None = None,
  ):
    self.ingestion = ingestion_application
    self.chunking_version = chunking_version
    self._reindex_project = reindex_project
    self._evaluate = evaluate

  @property
  def registry(self) -> dict[str, Callable[[dict], None]]:
    return {
      "rag.upsert": self.upsert,
      "rag.tombstone": self.tombstone,
      "rag.reindex_project": self.reindex_project,
      "rag.evaluate": self.evaluate,
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
    self.ingestion.ingest(normalized)

  def tombstone(self, payload: dict) -> None:
    document_ids = payload.get("document_ids")
    tenant_id = payload.get("tenant_id")
    content_version = payload.get("source_version")
    if not isinstance(document_ids, list) or not document_ids or not tenant_id or not content_version:
      raise PermanentJobError("invalid tenant-scoped tombstone")
    self.ingestion.tombstone(
      [str(document_id) for document_id in document_ids],
      tenant_id=str(tenant_id),
      content_version=str(content_version),
    )

  def reindex_project(self, payload: dict) -> None:
    if self._reindex_project is None:
      raise PermanentJobError("reindex handler is not configured")
    self._reindex_project(payload)

  def evaluate(self, payload: dict) -> None:
    if self._evaluate is None:
      raise PermanentJobError("evaluation handler is not configured")
    self._evaluate(payload)

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
      acl_subjects=list(dict.fromkeys(acl_subjects)),
    )
