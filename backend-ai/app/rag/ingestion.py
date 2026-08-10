from __future__ import annotations

from hashlib import sha256

from .models import ChunkRecord, SourceDocument
from .ports import EmbeddingProvider, IngestionPort


class DeterministicChunker:
  def __init__(self, *, max_chars: int = 1200, overlap_chars: int = 160):
    if max_chars < 16:
      raise ValueError("max_chars must be at least 16")
    if overlap_chars < 0 or overlap_chars >= max_chars:
      raise ValueError("overlap_chars must be non-negative and smaller than max_chars")
    self.max_chars = max_chars
    self.overlap_chars = overlap_chars

  def split(self, text: str) -> list[str]:
    normalized = "\n".join(line.strip() for line in text.splitlines()).strip()
    if not normalized:
      return []
    chunks: list[str] = []
    start = 0
    while start < len(normalized):
      hard_end = min(start + self.max_chars, len(normalized))
      end = hard_end
      if hard_end < len(normalized):
        candidates = [
          normalized.rfind("\n\n", start, hard_end),
          normalized.rfind(". ", start, hard_end),
          normalized.rfind(" ", start, hard_end),
        ]
        boundary = max(candidates)
        if boundary > start + self.max_chars // 2:
          end = boundary + (1 if normalized[boundary] == "." else 0)
      chunk = normalized[start:end].strip()
      if chunk:
        chunks.append(chunk)
      if end >= len(normalized):
        break
      start = max(end - self.overlap_chars, start + 1)
    return chunks


def build_chunk_records(
  document: SourceDocument,
  chunker: DeterministicChunker,
  *,
  embedding_version: str,
) -> list[ChunkRecord]:
  records: list[ChunkRecord] = []
  for position, text in enumerate(chunker.split(document.text)):
    checksum = sha256(text.encode("utf-8")).hexdigest()
    identity = "|".join(
      [
        document.tenant_id,
        document.document_id,
        document.content_version,
        embedding_version,
        str(position),
        checksum,
      ]
    )
    records.append(
      ChunkRecord(
        chunk_id=sha256(identity.encode("utf-8")).hexdigest(),
        document_id=document.document_id,
        tenant_id=document.tenant_id,
        project_id=document.project_id,
        owner_id=document.owner_id,
        source_type=document.source_type,
        source_uri=document.source_uri,
        title=document.title,
        text=text,
        position=position,
        checksum=checksum,
        content_version=document.content_version,
        embedding_version=embedding_version,
        acl_subjects=document.acl_subjects,
        deleted=document.deleted,
      )
    )
  return records


class IngestionApplication:
  def __init__(
    self,
    embedding_provider: EmbeddingProvider,
    ingestion_port: IngestionPort,
    chunker: DeterministicChunker | None = None,
  ):
    self.embedding_provider = embedding_provider
    self.ingestion_port = ingestion_port
    self.chunker = chunker or DeterministicChunker()

  def ingest(self, documents: list[SourceDocument]) -> dict:
    chunks = [
      chunk
      for document in documents
      for chunk in build_chunk_records(
        document,
        self.chunker,
        embedding_version=self.embedding_provider.version,
      )
    ]
    vectors = self.embedding_provider.embed([chunk.text for chunk in chunks]) if chunks else []
    self.ingestion_port.upsert(chunks, vectors)
    return {
      "documents": len(documents),
      "chunks": len(chunks),
      "embedding_version": self.embedding_provider.version,
    }

  def tombstone(self, document_ids: list[str], *, tenant_id: str, content_version: str) -> None:
    for document_id in document_ids:
      self.ingestion_port.tombstone(document_id, tenant_id, content_version)
