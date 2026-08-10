from __future__ import annotations

from typing import Protocol

from .models import (
  ChunkRecord,
  GenerationRequest,
  GenerationResult,
  RetrievalHit,
  RetrievalQuery,
  SourceDocument,
)


class Retriever(Protocol):
  def retrieve(self, query: RetrievalQuery) -> list[RetrievalHit]: ...


class EmbeddingProvider(Protocol):
  @property
  def version(self) -> str: ...

  def embed(self, texts: list[str]) -> list[list[float]]: ...


class GenerationProvider(Protocol):
  def generate(self, request: GenerationRequest) -> GenerationResult: ...


class DocumentStore(Protocol):
  def get(self, document_id: str, tenant_id: str) -> SourceDocument | None: ...

  def save(self, document: SourceDocument) -> None: ...

  def mark_deleted(self, document_id: str, tenant_id: str, content_version: str) -> None: ...


class IngestionPort(Protocol):
  def replace_documents(
    self,
    documents: list[SourceDocument],
    chunks: list[ChunkRecord],
    vectors: list[list[float]],
  ) -> None: ...

  def tombstone(self, document_id: str, tenant_id: str, content_version: str) -> None: ...


class FallbackClassifier(Protocol):
  def classify_task(self, task: str, use_rag: bool = False) -> dict: ...
