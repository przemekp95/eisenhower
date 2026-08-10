from __future__ import annotations

from ipaddress import ip_address
from time import monotonic
from urllib.parse import urlparse
from uuid import NAMESPACE_URL, uuid5

import httpx
from qdrant_client import models as qmodels

from ..generation.models import ClassificationOutput, GenerationResult
from ..generation.registry import PromptRegistry
from ..generation.renderer import PromptRenderer
from .errors import GenerationProviderError, GenerationProviderUnavailable, InvalidGenerationOutput
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
    return qmodels.Filter(
      must=[
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
    )


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
      self.client.set_payload(
        collection_name=self.collection_name,
        payload={"deleted": True},
        points=self._document_selector(document.document_id, document.tenant_id),
        wait=True,
      )
    points = [
      qmodels.PointStruct(
        id=str(uuid5(NAMESPACE_URL, chunk.chunk_id)),
        vector=vector,
        payload=chunk.model_dump(),
      )
      for chunk, vector in zip(chunks, vectors)
    ]
    if points:
      self.client.upsert(
        collection_name=self.collection_name,
        points=points,
        wait=True,
      )

  def tombstone(self, document_id: str, tenant_id: str, content_version: str) -> None:
    self.client.set_payload(
      collection_name=self.collection_name,
      payload={"deleted": True, "content_version": content_version},
      points=self._document_selector(document_id, tenant_id),
      wait=True,
    )

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


def is_private_service_url(base_url: str) -> bool:
  parsed = urlparse(base_url)
  if parsed.scheme not in {"http", "https"} or not parsed.hostname:
    return False
  hostname = parsed.hostname.lower()
  if hostname in {"localhost", "127.0.0.1", "::1"}:
    return True
  try:
    return ip_address(hostname).is_private
  except ValueError:
    return "." not in hostname or hostname.endswith((".internal", ".local"))


class VLLMGenerationProvider:
  def __init__(
    self,
    *,
    base_url: str,
    api_key: str,
    prompt_registry: PromptRegistry,
    prompt_renderer: PromptRenderer,
    prompt_id: str,
    prompt_version: str,
    timeout_seconds: float = 15.0,
    client: httpx.Client | None = None,
  ):
    if not is_private_service_url(base_url):
      raise ValueError("vLLM must use a fixed private-network endpoint")
    if not api_key:
      raise ValueError("vLLM API key is required")
    self.base_url = base_url.rstrip("/")
    self.api_key = api_key
    self.prompt_registry = prompt_registry
    self.prompt_renderer = prompt_renderer
    self.prompt_id = prompt_id
    self.prompt_version = prompt_version
    self.client = client or httpx.Client(timeout=timeout_seconds, follow_redirects=False)

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
      raise GenerationProviderUnavailable("vLLM request timed out") from error
    except httpx.RequestError as error:
      raise GenerationProviderUnavailable("vLLM request failed") from error
    except httpx.HTTPStatusError as error:
      if error.response.status_code == 429 or error.response.status_code >= 500:
        raise GenerationProviderUnavailable("vLLM request failed") from error
      raise InvalidGenerationOutput("vLLM rejected the generation contract") from error
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
      raise InvalidGenerationOutput("invalid vLLM output") from error


class CircuitBreakerGenerationProvider:
  def __init__(self, provider, *, failure_threshold: int = 3, reset_seconds: float = 30.0):
    if failure_threshold < 1 or reset_seconds <= 0:
      raise ValueError("Circuit-breaker limits must be positive")
    self.provider = provider
    self.failure_threshold = failure_threshold
    self.reset_seconds = reset_seconds
    self.failures = 0
    self.opened_at: float | None = None

  def generate(self, request: GenerationRequest) -> GenerationResult:
    if self.opened_at is not None:
      if monotonic() - self.opened_at < self.reset_seconds:
        raise GenerationProviderUnavailable("generation circuit breaker is open")
      self.opened_at = None
      self.failures = 0
    try:
      result = self.provider.generate(request)
      self.failures = 0
      return result
    except GenerationProviderError:
      self.failures += 1
      if self.failures >= self.failure_threshold:
        self.opened_at = monotonic()
      raise
