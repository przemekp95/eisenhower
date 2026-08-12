from __future__ import annotations

from typing import Protocol

from .models import (
  ChunkRecord,
  GenerationRequest,
  KnowledgeAnswerRequest,
  RetrievalHit,
  RetrievalQuery,
  SourceDocument,
)
from ..generation.models import GenerationResult, KnowledgeAnswerResult


class Retriever(Protocol):
  def retrieve(self, query: RetrievalQuery) -> list[RetrievalHit]: ...


class EmbeddingProvider(Protocol):
  @property
  def version(self) -> str: ...

  def embed(self, texts: list[str]) -> list[list[float]]: ...


class GenerationProvider(Protocol):
  def generate(self, request: GenerationRequest) -> GenerationResult: ...

  def answer(self, request: KnowledgeAnswerRequest) -> KnowledgeAnswerResult: ...


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

  def projected_chunks(self, document_id: str, tenant_id: str) -> set[tuple[str, str, str]]: ...


class FallbackClassifier(Protocol):
  def classify_task(self, task: str, use_rag: bool = False) -> dict: ...
