from __future__ import annotations

import re
from ipaddress import ip_address
from urllib.parse import urlparse

from qdrant_client import QdrantClient

from ..config import Settings
from ..generation.registry import PromptRegistry
from ..generation.renderer import HuggingFaceTokenCounter, PromptRenderer
from ..generation.delta import EmbeddingStatementSimilarity, InformationDeltaValidator
from .adapters import (
  CircuitBreakerGenerationProvider,
  MiniLMEmbeddingProvider,
  QdrantRetriever,
  QdrantIngestionAdapter,
  OpenAICompatibleGenerationProvider,
  is_private_service_url,
)
from .application import RagAnalysisService
from .canonical import CanonicalIngestionApplication, CanonicalRetriever
from .collections import QdrantCollectionManager
from .ingestion import DeterministicChunker
from .mongo_document_store import MongoCanonicalDocumentStore


def is_private_mongodb_uri(uri: str) -> bool:
  parsed = urlparse(uri)
  if parsed.scheme not in {"mongodb", "mongodb+srv"} or not parsed.hostname:
    return False
  hostname = parsed.hostname.lower()
  if hostname in {"localhost", "127.0.0.1", "::1"}:
    return True
  try:
    return ip_address(hostname).is_private
  except ValueError:
    return "." not in hostname or hostname.endswith((".internal", ".local"))


def build_rag_service(
  settings: Settings,
  fallback_classifier,
  *,
  qdrant_client=None,
  mongo_client=None,
) -> RagAnalysisService:
  if not settings.rag_retrieval_enabled:
    raise ValueError("RAG retrieval is disabled")
  if not is_private_service_url(settings.qdrant_url):
    raise ValueError("Qdrant must use a private-network endpoint")
  generator = _build_generation_provider(settings) if settings.rag_generation_enabled else None
  if not settings.mongodb_uri and mongo_client is None:
    raise ValueError("MONGODB_URI is required for canonical RAG retrieval")
  if settings.mongodb_uri and not is_private_mongodb_uri(settings.mongodb_uri):
    raise ValueError("MongoDB must use a fixed private-network endpoint")
  embedding = MiniLMEmbeddingProvider(
    fallback_classifier.local_model,
    version=settings.embedding_version,
  )
  qdrant = qdrant_client or QdrantClient(
    url=settings.qdrant_url,
    api_key=settings.qdrant_api_key,
    timeout=5,
  )
  projection_retriever = QdrantRetriever(
    qdrant,
    embedding,
    collection_alias=settings.qdrant_collection_alias,
  )
  if mongo_client is None:
    from pymongo import MongoClient

    mongo_client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=5000)
  mongo_client.admin.command("ping")
  canonical_store = MongoCanonicalDocumentStore(
    mongo_client[settings.mongodb_database][settings.canonical_documents_collection]
  )
  retriever = CanonicalRetriever(
    projection_retriever,
    canonical_store,
    embedding_version=settings.embedding_version,
    chunker=DeterministicChunker(max_chars=1200, overlap_chars=160),
  )
  return RagAnalysisService(
    retriever,
    generator,
    fallback_classifier,
    retrieval_version=settings.retrieval_version,
    index_version=settings.index_version,
    delta_validator=InformationDeltaValidator(EmbeddingStatementSimilarity(embedding)),
  )


def _build_generation_provider(settings: Settings):
  if not settings.inference_api_key or not settings.inference_model:
    raise ValueError("INFERENCE_API_KEY and INFERENCE_MODEL are required when RAG generation is enabled")
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
  if any(spec.model_id != settings.inference_model for spec in prompt_specs):
    raise ValueError("INFERENCE_MODEL must match the immutable PromptSpec model_id")
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
    OpenAICompatibleGenerationProvider(
      base_url=settings.inference_base_url,
      allowed_hosts=settings.inference_allowed_hosts,
      api_key=settings.inference_api_key,
      prompt_registry=prompt_registry,
      prompt_renderer=prompt_renderer,
      prompt_id=settings.prompt_id,
      prompt_version=settings.prompt_version,
      connect_timeout_seconds=settings.inference_connect_timeout_seconds,
      read_timeout_seconds=settings.inference_read_timeout_seconds,
      write_timeout_seconds=settings.inference_write_timeout_seconds,
      pool_timeout_seconds=settings.inference_pool_timeout_seconds,
    ),
    failure_threshold=settings.inference_circuit_failure_threshold,
    reset_seconds=settings.inference_circuit_reset_seconds,
  )


def build_ingestion_application(
  settings: Settings,
  ai_service,
  *,
  qdrant_client=None,
  mongo_client=None,
) -> CanonicalIngestionApplication:
  if not is_private_service_url(settings.qdrant_url):
    raise ValueError("Qdrant must use a private-network endpoint")
  if not settings.mongodb_uri and mongo_client is None:
    raise ValueError("MONGODB_URI is required for canonical RAG ingestion")
  if settings.mongodb_uri and not is_private_mongodb_uri(settings.mongodb_uri):
    raise ValueError("MongoDB must use a fixed private-network endpoint")
  embedding = MiniLMEmbeddingProvider(
    ai_service.local_model,
    version=settings.embedding_version,
  )
  qdrant = qdrant_client or QdrantClient(
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
  if mongo_client is None:
    from pymongo import MongoClient

    mongo_client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=5000)
  mongo_client.admin.command("ping")
  canonical_store = MongoCanonicalDocumentStore(
    mongo_client[settings.mongodb_database][settings.canonical_documents_collection]
  )
  return CanonicalIngestionApplication(
    embedding,
    canonical_store,
    adapter,
    DeterministicChunker(max_chars=1200, overlap_chars=160),
  )
