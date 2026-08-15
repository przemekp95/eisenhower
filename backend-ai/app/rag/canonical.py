from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from hashlib import sha256
from typing import Protocol

from .errors import ProjectionUnavailable
from .models import RetrievalHit, RetrievalQuery, SourceDocument
from .ports import ChunkingEngine, EmbeddingProvider, IngestionPort, Retriever


class CanonicalWriteStatus(str, Enum):
  ACCEPTED = "accepted"
  DUPLICATE = "duplicate"
  STALE = "stale"
  CONFLICT = "conflict"


@dataclass(frozen=True)
class CanonicalDocumentState:
  document: SourceDocument
  projection_pending: bool


class CanonicalDocumentStore(Protocol):
  def stage(self, document: SourceDocument) -> CanonicalWriteStatus: ...
  def mark_projected(self, document: SourceDocument) -> bool: ...
  def pending_documents(self, tenant_id: str, project_id: str | None = None) -> list[SourceDocument]: ...
  def project_documents(self, tenant_id: str, project_id: str | None = None) -> list[SourceDocument]: ...
  def get(self, tenant_id: str, document_id: str) -> SourceDocument | None: ...
  def retrieval_state(self, tenant_id: str, document_id: str) -> CanonicalDocumentState | None: ...


def canonical_document_is_visible(document: SourceDocument, query: RetrievalQuery) -> bool:
  """Apply the canonical tenant, project, tombstone, and ACL read boundary."""
  if document.deleted or document.tenant_id != query.scope.tenant_id:
    return False
  if document.project_id is not None and document.project_id not in query.scope.project_ids:
    return False
  if query.project_id is not None and document.project_id != query.project_id:
    return False
  return bool(set(document.acl_subjects) & set(query.scope.acl_subjects))


class CanonicalRetriever:
  """Treats vector results only as candidates and returns canonical content."""

  def __init__(
    self,
    projection: Retriever,
    document_store: CanonicalDocumentStore,
    *,
    embedding_version: str,
    chunking_engine: ChunkingEngine,
    candidate_multiplier: int = 4,
  ):
    if candidate_multiplier < 1:
      raise ValueError("candidate_multiplier must be positive")
    self.projection = projection
    self.document_store = document_store
    self.embedding_version = embedding_version
    self.chunking_engine = chunking_engine
    self.candidate_multiplier = candidate_multiplier

  def retrieve(self, query: RetrievalQuery) -> list[RetrievalHit]:
    candidate_limit = min(20, max(query.limit, query.limit * self.candidate_multiplier))
    candidates = self.projection.retrieve(query.model_copy(update={"limit": candidate_limit}))
    accepted: list[RetrievalHit] = []
    accepted_chunk_ids: set[str] = set()
    for candidate in candidates:
      state = self.document_store.retrieval_state(query.scope.tenant_id, candidate.document_id)
      if state is None or state.projection_pending:
        continue
      canonical = state.document
      if not canonical_document_is_visible(canonical, query):
        continue
      expected = next(
        (
          chunk
          for chunk in self.chunking_engine.build(canonical, embedding_version=self.embedding_version)
          if chunk.chunk_id == candidate.chunk_id
        ),
        None,
      )
      if expected is None or not self._candidate_matches(candidate, expected):
        continue
      if candidate.chunk_id in accepted_chunk_ids:
        continue
      accepted.append(
        RetrievalHit(
          chunk_id=expected.chunk_id,
          document_id=expected.document_id,
          text=expected.text,
          score=candidate.score,
          source_uri=expected.source_uri,
          title=expected.title,
          tenant_id=expected.tenant_id,
          project_id=expected.project_id,
          owner_id=expected.owner_id,
          embedding_version=expected.embedding_version,
          content_version=expected.content_version,
          source_type=expected.source_type,
        )
      )
      accepted_chunk_ids.add(candidate.chunk_id)
      if len(accepted) >= query.limit:
        break
    return accepted

  @staticmethod
  def _candidate_matches(candidate: RetrievalHit, expected) -> bool:
    return (
      candidate.document_id == expected.document_id
      and candidate.text == expected.text
      and candidate.source_uri == expected.source_uri
      and candidate.title == expected.title
      and candidate.tenant_id == expected.tenant_id
      and candidate.project_id == expected.project_id
      and candidate.owner_id == expected.owner_id
      and candidate.embedding_version == expected.embedding_version
      and candidate.content_version == expected.content_version
      and candidate.source_type == expected.source_type
    )


class CanonicalIngestionApplication:
  def __init__(
    self,
    embedding_provider: EmbeddingProvider,
    document_store: CanonicalDocumentStore,
    projection: IngestionPort,
    chunking_engine: ChunkingEngine,
  ):
    self.embedding_provider = embedding_provider
    self.document_store = document_store
    self.projection = projection
    self.chunking_engine = chunking_engine

  def ingest(self, documents: list[SourceDocument]) -> dict:
    counts = {status.value: 0 for status in CanonicalWriteStatus}
    projected = 0
    for document in documents:
      status = self.document_store.stage(document)
      counts[status.value] += 1
      current = document
      if status is CanonicalWriteStatus.DUPLICATE:
        state = self.document_store.retrieval_state(document.tenant_id, document.document_id)
        if state is None or not state.projection_pending:
          continue
        current = state.document
      elif status is not CanonicalWriteStatus.ACCEPTED:
        continue
      if self._project(current):
        projected += 1
    requested_keys = {(document.tenant_id, document.document_id) for document in documents}
    pending = sum(
      1
      for tenant_id, document_id in requested_keys
      if (
        (state := self.document_store.retrieval_state(tenant_id, document_id)) is not None
        and state.projection_pending
      )
    )
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
      if status is CanonicalWriteStatus.DUPLICATE:
        state = self.document_store.retrieval_state(tenant_id, document_id)
        if state is None or not state.projection_pending:
          continue
        current = state.document
      elif status is not CanonicalWriteStatus.ACCEPTED:
        continue
      if self._project(current):
        projected += 1
    pending = sum(
      1
      for document_id in set(document_ids)
      if (
        (state := self.document_store.retrieval_state(tenant_id, document_id)) is not None
        and state.projection_pending
      )
    )
    return {**counts, "projected": projected, "pending": pending}

  def _project(self, document: SourceDocument) -> bool:
    try:
      if document.deleted:
        self.projection.tombstone(
          document.document_id,
          document.tenant_id,
          document.content_version,
          source_sequence=document.source_sequence,
        )
      else:
        chunks = self.chunking_engine.build(document, embedding_version=self.embedding_provider.version)
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
      for chunk in self.chunking_engine.build(document, embedding_version=self.embedding_provider.version)
    }
    return actual == expected
