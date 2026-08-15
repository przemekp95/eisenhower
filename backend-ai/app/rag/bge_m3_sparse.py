from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from qdrant_client import models as qmodels

from .errors import ProjectionUnavailable
from .models import ChunkRecord, RetrievalHit, RetrievalQuery, SourceDocument


class BgeM3SparseEmbeddingProvider:
  """Minimal pinned BGE-M3 lexical head without the FlagEmbedding training stack."""

  def __init__(
    self,
    sentence_transformer,
    *,
    artifact_path: Path,
    artifact_sha256: str,
    version: str,
  ):
    if sha256(artifact_path.read_bytes()).hexdigest() != artifact_sha256:
      raise ValueError("BGE-M3 sparse artifact hash mismatch")
    import torch

    transformer = sentence_transformer[0]
    self.tokenizer = transformer.tokenizer
    self.encoder = transformer.auto_model
    parameter = next(self.encoder.parameters())
    self.device = parameter.device
    self.torch = torch
    self.sparse_linear = torch.nn.Linear(
      self.encoder.config.hidden_size,
      1,
      dtype=parameter.dtype,
      device=self.device,
    )
    state = torch.load(artifact_path, map_location="cpu", weights_only=True)
    self.sparse_linear.load_state_dict(state)
    self.sparse_linear.eval()
    self._version = version

  @property
  def version(self) -> str:
    return self._version

  def embed_sparse(self, texts: list[str]) -> list[dict[int, float]]:
    if not texts:
      return []
    inputs = self.tokenizer(
      texts,
      padding=True,
      truncation=True,
      max_length=512,
      return_tensors="pt",
    )
    inputs = {key: value.to(self.device) for key, value in inputs.items()}
    with self.torch.inference_mode():
      hidden = self.encoder(**inputs).last_hidden_state
      weights = self.torch.relu(self.sparse_linear(hidden)).squeeze(-1)
    token_rows = inputs["input_ids"].detach().cpu().tolist()
    mask_rows = inputs["attention_mask"].detach().cpu().tolist()
    weight_rows = weights.detach().float().cpu().tolist()
    excluded = set(self.tokenizer.all_special_ids)
    encoded = []
    for token_ids, attention, token_weights in zip(
      token_rows, mask_rows, weight_rows, strict=True,
    ):
      sparse: dict[int, float] = {}
      for token_id, present, weight in zip(token_ids, attention, token_weights, strict=True):
        if not present or token_id in excluded or weight <= 0:
          continue
        sparse[token_id] = max(sparse.get(token_id, 0.0), float(weight))
      encoded.append(sparse)
    return encoded


class QdrantSparseRetriever:
  def __init__(self, client, embedding_provider, *, collection_alias: str, vector_name: str):
    self.client = client
    self.embedding_provider = embedding_provider
    self.collection_alias = collection_alias
    self.vector_name = vector_name

  def retrieve(self, query: RetrievalQuery) -> list[RetrievalHit]:
    sparse = self.embedding_provider.embed_sparse([query.text])[0]
    if not sparse:
      return []
    result = self.client.query_points(
      collection_name=self.collection_alias,
      query=qmodels.SparseVector(
        indices=sorted(sparse),
        values=[sparse[index] for index in sorted(sparse)],
      ),
      using=self.vector_name,
      query_filter=self._build_filter(query),
      limit=query.limit,
      score_threshold=query.score_threshold,
      with_payload=True,
      with_vectors=False,
    )
    return [
      RetrievalHit(
        chunk_id=str((point.payload or {}).get("chunk_id") or point.id),
        document_id=str(point.payload["document_id"]),
        text=str(point.payload["text"]),
        score=float(point.score),
        source_uri=str(point.payload["source_uri"]),
        title=str(point.payload["title"]),
        tenant_id=str(point.payload["tenant_id"]),
        project_id=point.payload.get("project_id"),
        owner_id=point.payload.get("owner_id"),
        embedding_version=str(point.payload["embedding_version"]),
        content_version=str(point.payload["content_version"]),
        source_type=str(point.payload.get("source_type", "knowledge")),
      )
      for point in result.points
    ]

  def _build_filter(self, query: RetrievalQuery) -> qmodels.Filter:
    must = [
      qmodels.FieldCondition(
        key="tenant_id",
        match=qmodels.MatchValue(value=query.scope.tenant_id),
      ),
      qmodels.FieldCondition(
        key="embedding_version",
        match=qmodels.MatchValue(value=self.embedding_provider.version),
      ),
      qmodels.FieldCondition(
        key="acl_subjects",
        match=qmodels.MatchAny(any=query.scope.acl_subjects),
      ),
    ]
    if query.project_id is not None:
      must.append(qmodels.FieldCondition(
        key="project_id",
        match=qmodels.MatchValue(value=query.project_id),
      ))
    return qmodels.Filter(must=must)


class QdrantSparseIngestionAdapter:
  def __init__(self, client, *, collection_name: str, vector_name: str):
    self.client = client
    self.collection_name = collection_name
    self.vector_name = vector_name

  def replace_documents(
    self,
    documents: list[SourceDocument],
    chunks: list[ChunkRecord],
    vectors: list[dict[int, float]],
  ) -> None:
    if len(chunks) != len(vectors):
      raise ValueError("Every sparse chunk must have exactly one embedding vector")
    document_keys = {(document.tenant_id, document.document_id) for document in documents}
    if any((chunk.tenant_id, chunk.document_id) not in document_keys for chunk in chunks):
      raise ValueError("Every sparse chunk must belong to a supplied document")
    points = []
    for chunk, vector in zip(chunks, vectors, strict=True):
      if not vector:
        continue
      indexes = sorted(vector)
      points.append(qmodels.PointStruct(
        id=str(uuid5(NAMESPACE_URL, chunk.chunk_id)),
        vector={self.vector_name: qmodels.SparseVector(
          indices=indexes,
          values=[vector[index] for index in indexes],
        )},
        payload=chunk.model_dump(),
      ))
    if points:
      try:
        self.client.upsert(
          collection_name=self.collection_name,
          points=points,
          wait=True,
        )
      except Exception as error:
        raise ProjectionUnavailable("Qdrant sparse vector upsert failed") from error
