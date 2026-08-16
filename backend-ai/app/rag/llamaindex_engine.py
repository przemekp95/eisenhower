from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from threading import Lock

from llama_index.core import Document
from llama_index.core.ingestion import IngestionCache, IngestionPipeline
from llama_index.core.node_parser import SentenceSplitter
from llama_index.core.schema import MediaResource, MetadataMode
from llama_index.core.storage.kvstore import SimpleKVStore

from .ingestion import build_chunk_records_from_texts
from .models import ChunkRecord, SourceDocument


_POLICY_METADATA_KEYS = (
  "tenant_id",
  "project_id",
  "owner_id",
  "acl_subjects",
  "source_sequence",
  "content_version",
  "content_checksum",
  "pipeline_version",
)


class LlamaIndexChunkingEngine:
  """LlamaIndex mechanics behind project-owned canonical record contracts."""

  def __init__(
    self,
    *,
    chunk_size: int,
    chunk_overlap: int,
    pipeline_version: str,
    cache_path: Path | None = None,
  ):
    if not pipeline_version.strip():
      raise ValueError("pipeline_version is required")
    self.pipeline_version = pipeline_version
    self.cache_path = cache_path
    self._cache_lock = Lock()
    cache_store = (
      SimpleKVStore.from_persist_path(str(cache_path))
      if cache_path is not None and cache_path.exists()
      else SimpleKVStore()
    )
    self.pipeline = IngestionPipeline(
      transformations=[SentenceSplitter(chunk_size=chunk_size, chunk_overlap=chunk_overlap)],
      cache=IngestionCache(
        cache=cache_store,
        collection=f"eisenhower-{pipeline_version}",
      ),
    )

  def build(self, document: SourceDocument, *, embedding_version: str) -> list[ChunkRecord]:
    metadata = {
      "tenant_id": document.tenant_id,
      "project_id": document.project_id,
      "owner_id": document.owner_id,
      "acl_subjects": list(document.acl_subjects),
      "source_sequence": document.source_sequence,
      "content_version": document.content_version,
      "content_checksum": document.content_checksum,
      "pipeline_version": self.pipeline_version,
    }
    framework_document = Document(
      id_=self._document_node_id(document),
      text_resource=MediaResource(text=document.text),
      metadata=metadata,
      excluded_embed_metadata_keys=list(_POLICY_METADATA_KEYS),
      excluded_llm_metadata_keys=list(_POLICY_METADATA_KEYS),
    )
    nodes = self.pipeline.run(
      documents=[framework_document],
      cache_collection=self.pipeline_version,
      show_progress=False,
    )
    self._persist_cache()
    populated_nodes = [
      node for node in nodes
      if node.get_content(metadata_mode=MetadataMode.NONE).strip()
    ]
    texts = [node.get_content(metadata_mode=MetadataMode.NONE).strip() for node in populated_nodes]
    records = build_chunk_records_from_texts(
      document,
      [text for text in texts if text],
      embedding_version=embedding_version,
      identity_version=self.pipeline_version,
    )
    for node, record in zip(populated_nodes, records, strict=True):
      node.id_ = record.chunk_id
    return records

  @property
  def version(self) -> str:
    return self.pipeline_version

  def _persist_cache(self) -> None:
    if self.cache_path is None:
      return
    with self._cache_lock:
      self.cache_path.parent.mkdir(parents=True, exist_ok=True)
      temporary = self.cache_path.with_suffix(f"{self.cache_path.suffix}.tmp")
      self.pipeline.cache.cache.persist(str(temporary))
      temporary.replace(self.cache_path)

  def _document_node_id(self, document: SourceDocument) -> str:
    identity = "|".join(
      (
        document.tenant_id,
        document.document_id,
        document.content_version,
        str(document.source_sequence),
        document.content_checksum or "",
        self.pipeline_version,
      )
    )
    return sha256(identity.encode("utf-8")).hexdigest()
