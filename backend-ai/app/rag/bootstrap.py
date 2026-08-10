from __future__ import annotations

import re

from qdrant_client import QdrantClient

from ..config import Settings
from ..generation.registry import PromptRegistry
from ..generation.renderer import HuggingFaceTokenCounter, PromptRenderer
from .adapters import (
  CircuitBreakerGenerationProvider,
  MiniLMEmbeddingProvider,
  QdrantRetriever,
  QdrantIngestionAdapter,
  VLLMGenerationProvider,
  is_private_service_url,
)
from .application import RagAnalysisService
from .collections import QdrantCollectionManager
from .ingestion import DeterministicChunker, IngestionApplication


def build_rag_service(settings: Settings, fallback_classifier) -> RagAnalysisService:
  if not settings.rag_retrieval_enabled:
    raise ValueError("RAG retrieval is disabled")
  if not is_private_service_url(settings.qdrant_url):
    raise ValueError("Qdrant must use a private-network endpoint")
  embedding = MiniLMEmbeddingProvider(
    fallback_classifier.local_model,
    version=settings.embedding_version,
  )
  qdrant = QdrantClient(
    url=settings.qdrant_url,
    api_key=settings.qdrant_api_key,
    timeout=5,
  )
  retriever = QdrantRetriever(
    qdrant,
    embedding,
    collection_alias=settings.qdrant_collection_alias,
  )
  generator = _build_generation_provider(settings) if settings.rag_generation_enabled else None
  return RagAnalysisService(
    retriever,
    generator,
    fallback_classifier,
    retrieval_version=settings.retrieval_version,
    index_version=settings.index_version,
  )


def _build_generation_provider(settings: Settings):
  if not settings.vllm_api_key or not settings.vllm_model:
    raise ValueError("VLLM_API_KEY and VLLM_MODEL are required when RAG generation is enabled")
  prompt_registry = PromptRegistry.load_directory(settings.prompt_artifact_dir)
  prompt_specs = [
    prompt_registry.get(settings.prompt_id, settings.prompt_version, language)
    for language in ("pl", "en")
  ]
  if any(
    "_SELECTION_REQUIRED__" in spec.model_id
    or "_SELECTION_REQUIRED__" in spec.tokenizer_id
    or spec.chat_template_hash == "0" * 64
    for spec in prompt_specs
  ):
    raise ValueError("PromptSpec model selection is incomplete; RAG remains fail-closed")
  if any(spec.model_id != settings.vllm_model for spec in prompt_specs):
    raise ValueError("VLLM_MODEL must match the immutable PromptSpec model_id")
  reference = prompt_specs[0]
  if any(
    (spec.model_id, spec.model_revision, spec.tokenizer_id, spec.tokenizer_revision, spec.chat_template_hash)
    != (
      reference.model_id,
      reference.model_revision,
      reference.tokenizer_id,
      reference.tokenizer_revision,
      reference.chat_template_hash,
    )
    for spec in prompt_specs[1:]
  ):
    raise ValueError("PL and EN PromptSpec variants must pin the same model and tokenizer matrix")
  prompt_renderer = PromptRenderer(HuggingFaceTokenCounter.from_prompt_spec(reference))
  return CircuitBreakerGenerationProvider(
    VLLMGenerationProvider(
      base_url=settings.vllm_base_url,
      api_key=settings.vllm_api_key,
      prompt_registry=prompt_registry,
      prompt_renderer=prompt_renderer,
      prompt_id=settings.prompt_id,
      prompt_version=settings.prompt_version,
    ),
    failure_threshold=3,
    reset_seconds=30,
  )


def build_ingestion_application(settings: Settings, ai_service) -> IngestionApplication:
  if not is_private_service_url(settings.qdrant_url):
    raise ValueError("Qdrant must use a private-network endpoint")
  embedding = MiniLMEmbeddingProvider(
    ai_service.local_model,
    version=settings.embedding_version,
  )
  qdrant = QdrantClient(
    url=settings.qdrant_url,
    api_key=settings.qdrant_api_key,
    timeout=10,
  )
  probe_vector = embedding.embed(["embedding dimension probe"])[0]
  safe_version = re.sub(r"[^a-zA-Z0-9_-]", "-", settings.embedding_version)
  initial_collection = f"eisenhower-knowledge-{safe_version}"
  QdrantCollectionManager(
    qdrant,
    alias=settings.qdrant_collection_alias,
    vector_size=len(probe_vector),
  ).ensure_active(initial_collection)
  adapter = QdrantIngestionAdapter(
    qdrant,
    collection_name=settings.qdrant_collection_alias,
  )
  return IngestionApplication(
    embedding,
    adapter,
    DeterministicChunker(max_chars=1200, overlap_chars=160),
  )
