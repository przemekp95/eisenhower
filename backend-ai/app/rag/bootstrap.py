from __future__ import annotations

import re

from qdrant_client import QdrantClient

from ..config import Settings
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
  if not settings.rag_enabled:
    raise ValueError("RAG is disabled")
  if not settings.vllm_api_key or not settings.vllm_model:
    raise ValueError("VLLM_API_KEY and VLLM_MODEL are required when RAG is enabled")
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
  generator = CircuitBreakerGenerationProvider(
    VLLMGenerationProvider(
      base_url=settings.vllm_base_url,
      api_key=settings.vllm_api_key,
      model=settings.vllm_model,
    ),
    failure_threshold=3,
    reset_seconds=30,
  )
  return RagAnalysisService(retriever, generator, fallback_classifier)


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
