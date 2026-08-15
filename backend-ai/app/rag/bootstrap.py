from __future__ import annotations

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
  SentenceTransformerEmbeddingProvider,
  OpenAICompatibleGenerationProvider,
  is_private_service_url,
)
from .application import RagAnalysisService
from .canonical import CanonicalIngestionApplication, CanonicalRetriever
from .hybrid import CanonicalBm25Retriever, HybridRetriever, PrivateVllmReranker
from .llamaindex_engine import LlamaIndexChunkingEngine
from .qdrant_llamaindex import LlamaIndexQdrantProjection
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
  reranker_client=None,
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
  embedding = _build_retrieval_embedding(settings, fallback_classifier.local_model)
  qdrant = qdrant_client or QdrantClient(
    url=settings.qdrant_url,
    api_key=settings.qdrant_api_key,
    timeout=5,
  )
  _require_llamaindex_cutover(qdrant, settings)
  projection_retriever = LlamaIndexQdrantProjection(
    qdrant,
    embedding,
    collection_name=settings.qdrant_collection_alias,
  )
  if mongo_client is None:
    from pymongo import MongoClient

    mongo_client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=5000)
  mongo_client.admin.command("ping")
  canonical_store = MongoCanonicalDocumentStore(
    mongo_client[settings.mongodb_database][settings.canonical_documents_collection]
  )
  chunking_engine = _llamaindex_chunking_engine(settings)
  dense_retriever = CanonicalRetriever(
    projection_retriever,
    canonical_store,
    embedding_version=settings.embedding_version,
    chunking_engine=chunking_engine,
  )
  lexical_retriever = None
  reranker = None
  if settings.rag_retrieval_strategy == "hybrid-bge-v1":
    if not settings.reranker_api_key:
      raise ValueError("RERANKER_API_KEY is required for hybrid-bge-v1")
    lexical_retriever = CanonicalBm25Retriever(
      canonical_store,
      embedding_version=settings.embedding_version,
      chunking_engine=chunking_engine,
      title_weight=2.0,
      text_weight=1.0,
    )
    reranker = PrivateVllmReranker(
      settings.reranker_base_url,
      settings.reranker_api_key,
      allowed_hosts=settings.reranker_allowed_hosts,
      client=reranker_client,
    )

  def with_strategy(dense):
    if lexical_retriever is None or reranker is None:
      return dense
    return HybridRetriever(
      dense,
      lexical_retriever,
      rrf_k=20,
      dense_rrf_weight=1.0,
      lexical_rrf_weight=2.0,
      candidate_multiplier=4,
      reranker=reranker,
      reranker_candidate_limit=20,
      reranker_weight=1.0,
    )

  retriever = with_strategy(dense_retriever)
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
    prompt_registry.get(prompt_id, prompt_version, language)
    for prompt_id, prompt_version in (
      (settings.prompt_id, settings.prompt_version),
      (settings.knowledge_prompt_id, settings.knowledge_prompt_version),
    )
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
      knowledge_prompt_id=settings.knowledge_prompt_id,
      knowledge_prompt_version=settings.knowledge_prompt_version,
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
  embedding = _build_retrieval_embedding(settings, ai_service.local_model)
  qdrant = qdrant_client or QdrantClient(
    url=settings.qdrant_url,
    api_key=settings.qdrant_api_key,
    timeout=10,
  )
  _require_llamaindex_cutover(qdrant, settings)
  adapter = LlamaIndexQdrantProjection(
    qdrant,
    embedding,
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
    chunking_engine=_llamaindex_chunking_engine(settings),
  )


def _llamaindex_chunking_engine(settings: Settings) -> LlamaIndexChunkingEngine:
  return LlamaIndexChunkingEngine(
    chunk_size=settings.llamaindex_chunk_size,
    chunk_overlap=settings.llamaindex_chunk_overlap,
    pipeline_version=settings.llamaindex_pipeline_version,
    cache_path=settings.llamaindex_cache_path,
  )


def _require_llamaindex_cutover(qdrant, settings: Settings) -> None:
  """Fail closed if the runtime alias does not target the approved LlamaIndex collection."""
  if not hasattr(qdrant, "get_aliases"):
    return
  active = [
    str(alias.collection_name)
    for alias in qdrant.get_aliases().aliases
    if alias.alias_name == settings.qdrant_collection_alias
  ]
  if active != [settings.llamaindex_candidate_collection]:
    raise ValueError(
      "LlamaIndex runtime requires the guarded Qdrant alias cutover to the configured collection"
    )


def _build_retrieval_embedding(settings: Settings, local_model):
  if settings.rag_embedding_model_name is None:
    return MiniLMEmbeddingProvider(local_model, version=settings.embedding_version)
  return SentenceTransformerEmbeddingProvider(
    settings.rag_embedding_model_name,
    revision=settings.rag_embedding_model_revision or "",
    version=settings.embedding_version,
    device=settings.rag_embedding_device,
  )
