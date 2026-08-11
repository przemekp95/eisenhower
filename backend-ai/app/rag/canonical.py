from __future__ import annotations

from enum import Enum
from hashlib import sha256
from typing import Protocol

from .ingestion import DeterministicChunker, build_chunk_records
from .errors import ProjectionUnavailable
from .models import SourceDocument
from .ports import EmbeddingProvider, IngestionPort


class CanonicalWriteStatus(str, Enum):
  ACCEPTED = "accepted"
  DUPLICATE = "duplicate"
  STALE = "stale"
  CONFLICT = "conflict"


class CanonicalDocumentStore(Protocol):
  def stage(self, document: SourceDocument) -> CanonicalWriteStatus: ...
  def mark_projected(self, document: SourceDocument) -> bool: ...
  def pending_documents(self, tenant_id: str, project_id: str | None = None) -> list[SourceDocument]: ...
  def project_documents(self, tenant_id: str, project_id: str | None = None) -> list[SourceDocument]: ...
  def get(self, tenant_id: str, document_id: str) -> SourceDocument | None: ...


class CanonicalIngestionApplication:
  def __init__(
    self,
    embedding_provider: EmbeddingProvider,
    document_store: CanonicalDocumentStore,
    projection: IngestionPort,
    chunker: DeterministicChunker | None = None,
  ):
    self.embedding_provider = embedding_provider
    self.document_store = document_store
    self.projection = projection
    self.chunker = chunker or DeterministicChunker()

  def ingest(self, documents: list[SourceDocument]) -> dict:
    counts = {status.value: 0 for status in CanonicalWriteStatus}
    projected = 0
    for document in documents:
      status = self.document_store.stage(document)
      counts[status.value] += 1
      if status is not CanonicalWriteStatus.ACCEPTED:
        continue
      if self._project(document):
        projected += 1
    scopes = {(document.tenant_id, document.project_id) for document in documents}
    pending = sum(len(self.document_store.pending_documents(tenant_id, project_id)) for tenant_id, project_id in scopes)
    return {
      **counts,
      "projected": projected,
      "pending": pending,
      "embedding_version": self.embedding_provider.version,
    }

  def reconcile(self, tenant_id: str, project_id: str | None = None) -> dict:
    projected = 0
    drifted = 0
    pending_keys = {
      (document.tenant_id, document.document_id)
      for document in self.document_store.pending_documents(tenant_id, project_id)
    }
    for document in self.document_store.project_documents(tenant_id, project_id):
      if (document.tenant_id, document.document_id) in pending_keys or not self._projection_matches(document):
        drifted += (document.tenant_id, document.document_id) not in pending_keys
        if self._project(document):
          projected += 1
    pending = len(self.document_store.pending_documents(tenant_id, project_id))
    return {"projected": projected, "pending": pending, "drifted": drifted}

  def reindex_project(self, tenant_id: str, project_id: str) -> dict:
    projected = 0
    documents = self.document_store.project_documents(tenant_id, project_id)
    for document in documents:
      if self._project(document):
        projected += 1
    pending = len(self.document_store.pending_documents(tenant_id, project_id))
    return {"documents": len(documents), "projected": projected, "pending": pending}

  def tombstone(
    self,
    document_ids: list[str],
    *,
    tenant_id: str,
    content_version: str,
    source_sequence: int,
  ) -> dict:
    counts = {status.value: 0 for status in CanonicalWriteStatus}
    projected = 0
    for document_id in document_ids:
      current = self.document_store.get(tenant_id, document_id)
      if current is None:
        current = SourceDocument(
          document_id=document_id,
          tenant_id=tenant_id,
          source_type="knowledge",
          source_uri=f"eisenhower://deleted/{document_id}",
          title="[deleted]",
          text="",
          content_version=content_version,
          content_checksum=sha256(b"").hexdigest(),
          source_sequence=source_sequence,
          acl_subjects=[f"tenant:{tenant_id}"],
          deleted=True,
        )
      else:
        current = current.model_copy(
          update={
            "title": "[deleted]",
            "text": "",
            "content_version": content_version,
            "content_checksum": sha256(b"").hexdigest(),
            "source_sequence": source_sequence,
            "deleted": True,
          }
        )
      status = self.document_store.stage(current)
      counts[status.value] += 1
      if status is CanonicalWriteStatus.ACCEPTED and self._project(current):
        projected += 1
    pending = len(self.document_store.pending_documents(tenant_id))
    return {**counts, "projected": projected, "pending": pending}

  def _project(self, document: SourceDocument) -> bool:
    try:
      if document.deleted:
        self.projection.tombstone(document.document_id, document.tenant_id, document.content_version)
      else:
        chunks = build_chunk_records(document, self.chunker, embedding_version=self.embedding_provider.version)
        vectors = self.embedding_provider.embed([chunk.text for chunk in chunks]) if chunks else []
        self.projection.replace_documents([document], chunks, vectors)
    except ProjectionUnavailable:
      return False
    return self.document_store.mark_projected(document)

  def _projection_matches(self, document: SourceDocument) -> bool:
    actual = self.projection.projected_chunks(document.document_id, document.tenant_id)
    if document.deleted:
      return not actual
    expected = {
      (chunk.chunk_id, chunk.checksum, chunk.content_version)
      for chunk in build_chunk_records(
        document,
        self.chunker,
        embedding_version=self.embedding_provider.version,
      )
    }
    return actual == expected
