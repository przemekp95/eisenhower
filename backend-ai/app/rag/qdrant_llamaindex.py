from __future__ import annotations

from uuid import NAMESPACE_URL, uuid5

from llama_index.core.schema import MediaResource, MetadataMode, TextNode
from llama_index.core.vector_stores.types import FilterOperator, MetadataFilter, MetadataFilters, VectorStoreQuery
from llama_index.vector_stores.qdrant import QdrantVectorStore
from qdrant_client.http import models as qmodels

from .errors import ProjectionUnavailable
from .models import ChunkRecord, RetrievalHit, RetrievalQuery, SourceDocument
from .ports import EmbeddingProvider


_TECHNICAL_METADATA = (
  "tenant_id",
  "project_id",
  "owner_id",
  "acl_subjects",
  "source_sequence",
  "embedding_version",
  "content_version",
  "checksum",
  "deleted",
)


def _document_filters(document_id: str, tenant_id: str) -> MetadataFilters:
  return MetadataFilters(
    filters=[
      MetadataFilter(key="tenant_id", value=tenant_id),
      MetadataFilter(key="eisenhower_document_id", value=document_id),
    ]
  )


class LlamaIndexQdrantProjection:
  """Native LlamaIndex Qdrant mechanics isolated behind Eisenhower DTO ports."""

  def __init__(
    self,
    client,
    embedding_provider: EmbeddingProvider,
    *,
    collection_name: str,
  ):
    if not collection_name.strip():
      raise ValueError("LlamaIndex collection name is required")
    self.embedding_provider = embedding_provider
    self.collection_name = collection_name
    self.store = QdrantVectorStore(
      collection_name=collection_name,
      client=client,
      enable_hybrid=False,
      payload_indexes=[
        {"field_name": "tenant_id", "field_schema": qmodels.PayloadSchemaType.KEYWORD},
        {"field_name": "project_id", "field_schema": qmodels.PayloadSchemaType.KEYWORD},
        {"field_name": "eisenhower_document_id", "field_schema": qmodels.PayloadSchemaType.KEYWORD},
        {"field_name": "embedding_version", "field_schema": qmodels.PayloadSchemaType.KEYWORD},
        {"field_name": "acl_subjects", "field_schema": qmodels.PayloadSchemaType.KEYWORD},
      ],
    )

  def replace_documents(
    self,
    documents: list[SourceDocument],
    chunks: list[ChunkRecord],
    vectors: list[list[float]],
  ) -> None:
    if len(chunks) != len(vectors):
      raise ValueError("Every chunk must have exactly one embedding vector")
    document_keys = {(document.tenant_id, document.document_id) for document in documents}
    if len(document_keys) != len(documents):
      raise ValueError("Every replacement document must be unique within its tenant")
    if any((chunk.tenant_id, chunk.document_id) not in document_keys for chunk in chunks):
      raise ValueError("Every replacement chunk must belong to a supplied document")
    try:
      chunk_vectors = list(zip(chunks, vectors, strict=True))
      plans = []
      for document in documents:
        document_pairs = [
          pair for pair in chunk_vectors
          if pair[0].tenant_id == document.tenant_id and pair[0].document_id == document.document_id
        ]
        existing = self._document_nodes(document.document_id, document.tenant_id)
        existing_sequences = [int(node.metadata.get("source_sequence", 0)) for node in existing]
        newest_sequence = max(existing_sequences, default=-1)
        if newest_sequence > document.source_sequence:
          plans.append((document, [], True))
          continue
        if newest_sequence == document.source_sequence:
          actual = {
            (
              str(node.metadata["chunk_id"]),
              str(node.metadata["checksum"]),
              str(node.metadata["content_version"]),
            )
            for node in existing
            if int(node.metadata.get("source_sequence", 0)) == document.source_sequence
          }
          expected = {
            (chunk.chunk_id, chunk.checksum, chunk.content_version)
            for chunk, _vector in document_pairs
          }
          if actual != expected:
            raise ProjectionUnavailable("LlamaIndex Qdrant conflicting sequence")
          plans.append((document, [], True))
          continue
        plans.append((document, document_pairs, False))

      for document, document_pairs, skip in plans:
        if skip:
          continue
        nodes = [self._node(chunk, vector) for chunk, vector in document_pairs]
        if nodes:
          self.store.add(nodes)
        self._delete_older_versions(document)
    except ProjectionUnavailable:
      raise
    except Exception as error:
      raise ProjectionUnavailable("LlamaIndex Qdrant replacement failed") from error

  def tombstone(
    self,
    document_id: str,
    tenant_id: str,
    content_version: str,
    *,
    source_sequence: int,
  ) -> None:
    del content_version
    try:
      if self.store.client.collection_exists(self.collection_name):
        existing = self._document_nodes(document_id, tenant_id)
        newest_sequence = max(
          (int(node.metadata.get("source_sequence", 0)) for node in existing),
          default=-1,
        )
        if newest_sequence > source_sequence:
          return
        self.store.client.delete(
          collection_name=self.collection_name,
          points_selector=qmodels.FilterSelector(
            filter=qmodels.Filter(
              must=[
                qmodels.FieldCondition(
                  key="tenant_id",
                  match=qmodels.MatchValue(value=tenant_id),
                ),
                qmodels.FieldCondition(
                  key="eisenhower_document_id",
                  match=qmodels.MatchValue(value=document_id),
                ),
                qmodels.FieldCondition(
                  key="source_sequence",
                  range=qmodels.Range(lte=source_sequence),
                ),
              ]
            )
          ),
          wait=True,
        )
    except Exception as error:
      raise ProjectionUnavailable("LlamaIndex Qdrant tombstone failed") from error

  def projected_chunks(self, document_id: str, tenant_id: str) -> set[tuple[str, str, str]]:
    try:
      if not self.store.client.collection_exists(self.collection_name):
        return set()
      nodes = self.store.get_nodes(filters=_document_filters(document_id, tenant_id), limit=1_000)
    except Exception as error:
      raise ProjectionUnavailable("LlamaIndex Qdrant projection read failed") from error
    return {
      (str(node.metadata["chunk_id"]), str(node.metadata["checksum"]), str(node.metadata["content_version"]))
      for node in nodes
    }

  def retrieve(self, query: RetrievalQuery) -> list[RetrievalHit]:
    filters = [
      MetadataFilter(key="tenant_id", value=query.scope.tenant_id),
      MetadataFilter(key="embedding_version", value=self.embedding_provider.version),
      MetadataFilter(key="eisenhower_deleted", value="false"),
      MetadataFilter(
        key="acl_subjects",
        value=query.scope.acl_subjects,
        operator=FilterOperator.IN,
      ),
    ]
    if query.project_id is not None:
      filters.append(MetadataFilter(key="project_id", value=query.project_id))
    vector = self.embedding_provider.embed([query.text])[0]
    try:
      if not self.store.client.collection_exists(self.collection_name):
        return []
      result = self.store.query(
        VectorStoreQuery(
          query_embedding=vector,
          similarity_top_k=query.limit,
          filters=MetadataFilters(filters=filters),
        )
      )
    except Exception as error:
      raise ProjectionUnavailable("LlamaIndex Qdrant retrieval failed") from error
    hits = []
    for node, score in zip(result.nodes or (), result.similarities or (), strict=True):
      if score < query.score_threshold:
        continue
      metadata = node.metadata
      hits.append(
        RetrievalHit(
          chunk_id=str(metadata["chunk_id"]),
          document_id=str(metadata["document_id"]),
          text=node.get_content(metadata_mode=MetadataMode.NONE),
          score=float(score),
          source_uri=str(metadata["source_uri"]),
          title=str(metadata["title"]),
          tenant_id=str(metadata["tenant_id"]),
          project_id=metadata.get("project_id"),
          owner_id=metadata.get("owner_id"),
          embedding_version=str(metadata["embedding_version"]),
          content_version=str(metadata["content_version"]),
          source_type=str(metadata.get("source_type", "knowledge")),
        )
      )
    return hits

  @staticmethod
  def _node(chunk: ChunkRecord, vector: list[float]) -> TextNode:
    metadata = chunk.model_dump()
    metadata["eisenhower_document_id"] = chunk.document_id
    metadata["eisenhower_deleted"] = "true" if chunk.deleted else "false"
    return TextNode(
      id_=str(uuid5(NAMESPACE_URL, chunk.chunk_id)),
      text_resource=MediaResource(text=chunk.text),
      metadata=metadata,
      embedding=vector,
      excluded_embed_metadata_keys=list(_TECHNICAL_METADATA),
      excluded_llm_metadata_keys=list(_TECHNICAL_METADATA),
    )

  def _delete_document(self, document_id: str, tenant_id: str) -> None:
    self.store.client.delete(
      collection_name=self.collection_name,
      points_selector=qmodels.FilterSelector(
        filter=qmodels.Filter(
          must=[
            qmodels.FieldCondition(
              key="tenant_id",
              match=qmodels.MatchValue(value=tenant_id),
            ),
            qmodels.FieldCondition(
              key="eisenhower_document_id",
              match=qmodels.MatchValue(value=document_id),
            ),
          ]
        )
      ),
      wait=True,
    )

  def _document_nodes(self, document_id: str, tenant_id: str):
    if not self.store.client.collection_exists(self.collection_name):
      return []
    return self.store.get_nodes(filters=_document_filters(document_id, tenant_id), limit=10_000)

  def _delete_older_versions(self, document: SourceDocument) -> None:
    self.store.client.delete(
      collection_name=self.collection_name,
      points_selector=qmodels.FilterSelector(
        filter=qmodels.Filter(
          must=[
            qmodels.FieldCondition(
              key="tenant_id",
              match=qmodels.MatchValue(value=document.tenant_id),
            ),
            qmodels.FieldCondition(
              key="eisenhower_document_id",
              match=qmodels.MatchValue(value=document.document_id),
            ),
            qmodels.FieldCondition(
              key="source_sequence",
              range=qmodels.Range(lt=document.source_sequence),
            ),
          ]
        )
      ),
      wait=True,
    )
