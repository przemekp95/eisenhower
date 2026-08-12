from __future__ import annotations

from ipaddress import ip_address
from threading import Lock
from time import monotonic
from urllib.parse import urlparse
from uuid import NAMESPACE_URL, uuid5

import httpx
from qdrant_client import models as qmodels

from ..generation.models import ClassificationOutput, GenerationResult
from ..generation.registry import PromptRegistry
from ..generation.renderer import PromptRenderer
from .errors import (
  GenerationProviderError,
  GenerationProviderUnavailable,
  InvalidGenerationOutput,
  ProjectionUnavailable,
)
from .models import ChunkRecord, GenerationRequest, RetrievalHit, RetrievalQuery, SourceDocument
from .ports import EmbeddingProvider


class MiniLMEmbeddingProvider:
  def __init__(self, local_model, *, version: str):
    self.local_model = local_model
    self._version = version

  @property
  def version(self) -> str:
    return self._version

  def embed(self, texts: list[str]) -> list[list[float]]:
    return [[float(value) for value in self.local_model.encode_text(text)] for text in texts]


class QdrantRetriever:
  def __init__(self, client, embedding_provider: EmbeddingProvider, *, collection_alias: str):
    self.client = client
    self.embedding_provider = embedding_provider
    self.collection_alias = collection_alias

  def retrieve(self, query: RetrievalQuery) -> list[RetrievalHit]:
    vector = self.embedding_provider.embed([query.text])[0]
    result = self.client.query_points(
      collection_name=self.collection_alias,
      query=vector,
      query_filter=self._build_filter(query),
      limit=query.limit,
      score_threshold=query.score_threshold,
      with_payload=True,
      with_vectors=False,
    )
    hits: list[RetrievalHit] = []
    for point in result.points:
      payload = dict(point.payload or {})
      hits.append(
        RetrievalHit(
          chunk_id=str(payload.get("chunk_id") or point.id),
          document_id=str(payload["document_id"]),
          text=str(payload["text"]),
          score=float(point.score),
          source_uri=str(payload["source_uri"]),
          title=str(payload["title"]),
          tenant_id=str(payload["tenant_id"]),
          project_id=payload.get("project_id"),
          owner_id=payload.get("owner_id"),
          embedding_version=str(payload["embedding_version"]),
          content_version=str(payload["content_version"]),
          source_type=str(payload.get("source_type", "knowledge")),
        )
      )
    return hits

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
          key="deleted",
          match=qmodels.MatchValue(value=False),
        ),
        qmodels.FieldCondition(
          key="acl_subjects",
          match=qmodels.MatchAny(any=query.scope.acl_subjects),
        ),
    ]
    if query.project_id is not None:
      must.append(
        qmodels.FieldCondition(
          key="project_id",
          match=qmodels.MatchValue(value=query.project_id),
        )
      )
    return qmodels.Filter(must=must)


class QdrantIngestionAdapter:
  def __init__(self, client, *, collection_name: str):
    self.client = client
    self.collection_name = collection_name

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
    for document in documents:
      try:
        self.client.delete(
          collection_name=self.collection_name,
          points_selector=self._document_selector(document.document_id, document.tenant_id),
          wait=True,
        )
      except Exception as error:
        raise ProjectionUnavailable("Qdrant document replacement failed") from error
    points = [
      qmodels.PointStruct(
        id=str(uuid5(NAMESPACE_URL, chunk.chunk_id)),
        vector=vector,
        payload=chunk.model_dump(),
      )
      for chunk, vector in zip(chunks, vectors)
    ]
    if points:
      try:
        self.client.upsert(
          collection_name=self.collection_name,
          points=points,
          wait=True,
        )
      except Exception as error:
        raise ProjectionUnavailable("Qdrant vector upsert failed") from error

  def tombstone(self, document_id: str, tenant_id: str, content_version: str) -> None:
    del content_version  # The canonical tombstone owns the version; Qdrant retains no private body.
    try:
      self.client.delete(
        collection_name=self.collection_name,
        points_selector=self._document_selector(document_id, tenant_id),
        wait=True,
      )
    except Exception as error:
      raise ProjectionUnavailable("Qdrant tombstone failed") from error

  def projected_chunks(self, document_id: str, tenant_id: str) -> set[tuple[str, str, str]]:
    projected = set()
    offset = None
    try:
      while True:
        points, next_offset = self.client.scroll(
          collection_name=self.collection_name,
          scroll_filter=self._document_selector(document_id, tenant_id).filter,
          limit=1_000,
          offset=offset,
          with_payload=True,
          with_vectors=False,
        )
        projected.update(
          (str(point.payload["chunk_id"]), str(point.payload["checksum"]), str(point.payload["content_version"]))
          for point in points
          if point.payload and point.payload.get("deleted") is False
        )
        if next_offset is None:
          break
        offset = next_offset
    except Exception as error:
      raise ProjectionUnavailable("Qdrant projection inspection failed") from error
    return projected

  @staticmethod
  def _document_selector(document_id: str, tenant_id: str) -> qmodels.FilterSelector:
    return qmodels.FilterSelector(
      filter=qmodels.Filter(
        must=[
          qmodels.FieldCondition(
            key="tenant_id",
            match=qmodels.MatchValue(value=tenant_id),
          ),
          qmodels.FieldCondition(
            key="document_id",
            match=qmodels.MatchValue(value=document_id),
          ),
        ]
      )
    )


def is_private_service_url(base_url: str, *, allowed_hosts: tuple[str, ...] = ()) -> bool:
  parsed = urlparse(base_url)
  if parsed.scheme not in {"http", "https"} or not parsed.hostname:
    return False
  if any(("@" in parsed.netloc, bool(parsed.query), bool(parsed.fragment))):
    return False
  hostname = parsed.hostname.lower()
  normalized_allowed = {host.strip().lower().rstrip(".") for host in allowed_hosts if host.strip()}
  if hostname.rstrip(".") in normalized_allowed:
    return True
  if hostname in {"localhost", "127.0.0.1", "::1"}:
    return True
  try:
    return ip_address(hostname).is_private
  except ValueError:
    return "." not in hostname or hostname.endswith((".internal", ".local"))


class OpenAICompatibleGenerationProvider:
  def __init__(
    self,
    *,
    base_url: str,
    api_key: str,
    prompt_registry: PromptRegistry,
    prompt_renderer: PromptRenderer,
    prompt_id: str,
    prompt_version: str,
    allowed_hosts: tuple[str, ...] = (),
    connect_timeout_seconds: float = 2.0,
    read_timeout_seconds: float = 15.0,
    write_timeout_seconds: float = 5.0,
    pool_timeout_seconds: float = 1.0,
    client: httpx.Client | None = None,
  ):
    if not is_private_service_url(base_url, allowed_hosts=allowed_hosts):
      raise ValueError("Inference provider must use a fixed private-network endpoint")
    if not api_key:
      raise ValueError("Inference provider service API key is required")
    self.base_url = base_url.rstrip("/")
    self.api_key = api_key
    self.prompt_registry = prompt_registry
    self.prompt_renderer = prompt_renderer
    self.prompt_id = prompt_id
    self.prompt_version = prompt_version
    self.client = client or httpx.Client(
      timeout=httpx.Timeout(
        connect=connect_timeout_seconds,
        read=read_timeout_seconds,
        write=write_timeout_seconds,
        pool=pool_timeout_seconds,
      ),
      follow_redirects=False,
    )

  def generate(self, request: GenerationRequest) -> GenerationResult:
    spec = self.prompt_registry.get(self.prompt_id, self.prompt_version, request.language)
    rendered = self.prompt_renderer.render(spec, request)
    generation = spec.generation_config
    payload = {
      "model": spec.model_id,
      "temperature": generation.temperature,
      "top_p": generation.top_p,
      "n": generation.n,
      "max_tokens": generation.max_tokens,
      "messages": list(rendered.messages),
      "response_format": {
        "type": "json_schema",
        "json_schema": {
          "name": spec.output_schema_id,
          "strict": True,
          "schema": ClassificationOutput.model_json_schema(),
        },
      },
    }
    if generation.seed is not None:
      payload["seed"] = generation.seed
    try:
      response = self.client.post(
        f"{self.base_url}/chat/completions",
        headers={"Authorization": f"Bearer {self.api_key}"},
        json=payload,
      )
      response.raise_for_status()
    except httpx.TimeoutException as error:
      raise GenerationProviderUnavailable(
        "Inference provider request timed out",
        reason="generation_timeout",
      ) from error
    except httpx.RequestError as error:
      raise GenerationProviderUnavailable(
        "Inference provider connection failed",
        reason="generation_connection_error",
      ) from error
    except httpx.HTTPStatusError as error:
      if error.response.status_code == 429:
        raise GenerationProviderUnavailable(
          "Inference provider rate limited the request",
          reason="generation_rate_limited",
        ) from error
      if error.response.status_code >= 500:
        raise GenerationProviderUnavailable(
          "Inference provider returned a server error",
          reason="generation_server_error",
        ) from error
      raise InvalidGenerationOutput("Inference provider rejected the generation contract") from error
    try:
      body = response.json()
      content = body["choices"][0]["message"]["content"]
      output = ClassificationOutput.model_validate_json(content)
      allowed = set(rendered.allowed_chunk_ids)
      if any(chunk_id not in allowed for chunk_id in output.citations):
        raise ValueError("Generated citation is outside the rendered context")
      if any(item.chunk_id not in allowed for item in output.evidence):
        raise ValueError("Generated evidence is outside the rendered context")
      return GenerationResult(
        output=output,
        execution_id=rendered.execution_id,
        prompt_id=spec.prompt_id,
        prompt_version=spec.prompt_version,
        language=spec.language,
        model_id=spec.model_id,
        model_revision=spec.model_revision,
        schema_version=spec.output_schema_version,
        input_tokens=rendered.input_tokens,
        context_chunk_ids=list(rendered.allowed_chunk_ids),
      )
    except (KeyError, IndexError, TypeError, ValueError) as error:
      raise InvalidGenerationOutput("invalid inference provider output") from error


# Compatibility import for existing opt-in live-vLLM checks. Application code uses
# the vendor-neutral name above; vLLM remains one OpenAI-compatible implementation.
VLLMGenerationProvider = OpenAICompatibleGenerationProvider


class CircuitBreakerGenerationProvider:
  def __init__(self, provider, *, failure_threshold: int = 3, reset_seconds: float = 30.0):
    if failure_threshold < 1 or reset_seconds <= 0:
      raise ValueError("Circuit-breaker limits must be positive")
    self.provider = provider
    self.failure_threshold = failure_threshold
    self.reset_seconds = reset_seconds
    self.failures = 0
    self.opened_at: float | None = None
    self._half_open_probe = False
    self._lock = Lock()

  def status(self) -> dict[str, str | int]:
    with self._lock:
      state = "half_open" if self._half_open_probe else "open" if self.opened_at is not None else "closed"
      return {"state": state, "failures": self.failures}

  def generate(self, request: GenerationRequest) -> GenerationResult:
    with self._lock:
      if self.opened_at is not None:
        if monotonic() - self.opened_at < self.reset_seconds or self._half_open_probe:
          raise GenerationProviderUnavailable(
            "generation circuit breaker is open",
            reason="generation_circuit_open",
          )
        self._half_open_probe = True
    try:
      result = self.provider.generate(request)
      with self._lock:
        self.failures = 0
        self.opened_at = None
        self._half_open_probe = False
      return result
    except GenerationProviderError:
      with self._lock:
        self.failures += 1
        if self.failures >= self.failure_threshold or self._half_open_probe:
          self.opened_at = monotonic()
        self._half_open_probe = False
      raise
