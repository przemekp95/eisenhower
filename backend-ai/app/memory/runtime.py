from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from qdrant_client import QdrantClient

from app.rag.adapters import (
  MiniLMEmbeddingProvider,
  SentenceTransformerEmbeddingProvider,
  is_private_service_url,
)
from app.rag.bootstrap import create_mongo_client, is_private_mongodb_uri

from .adapters import (
  HmacConsentReceiptVerifier,
  MongoMemoryRepository,
  QdrantMemoryCandidateIndex,
  QdrantMemoryProjection,
)
from .application import MemoryApplication
from .policy import MemoryPolicy
from .ports import Clock
from .reconciliation import MemoryProjectionReconciler


class UtcClock:
  def now(self) -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class MemoryRuntime:
  application: MemoryApplication
  confirmation_signer: HmacConsentReceiptVerifier
  clock: Clock
  policy: MemoryPolicy
  reconciler: MemoryProjectionReconciler | None = None


def build_memory_runtime(
  settings,
  ai_service,
  *,
  audit_sink=None,
  mongo_client=None,
  qdrant_client=None,
) -> MemoryRuntime:
  """Compose governed memory only after every rollout dependency is explicit."""
  if not settings.memory_write_enabled:
    raise ValueError("Memory runtime requires MEMORY_WRITE_ENABLED")
  if settings.memory_policy_path is None:
    raise ValueError("MEMORY_POLICY_PATH is required when memory writes are enabled")
  policy = MemoryPolicy.load(settings.memory_policy_path)
  _validate_rollout(settings, policy)
  if not settings.memory_consent_hmac_key:
    raise ValueError("MEMORY_CONSENT_HMAC_KEY is required when memory writes are enabled")
  if not settings.mongodb_uri and mongo_client is None:
    raise ValueError("MONGODB_URI is required for canonical memory persistence")
  if settings.mongodb_uri and not is_private_mongodb_uri(settings.mongodb_uri):
    raise ValueError("Memory MongoDB must use a private-network endpoint")
  if settings.memory_retrieval_enabled:
    _validate_projection_settings(settings, policy)

  mongo = mongo_client or create_mongo_client(settings.mongodb_uri)
  mongo.admin.command("ping")
  database = mongo[settings.mongodb_database]
  repository = MongoMemoryRepository(
    database.memory_records,
    database.memory_idempotency,
    client=mongo,
  )
  clock = UtcClock()
  signer = HmacConsentReceiptVerifier(
    {settings.memory_consent_hmac_key_id: settings.memory_consent_hmac_key.encode("utf-8")}
  )

  candidate_index = None
  reconciler = None
  if settings.memory_retrieval_enabled:
    qdrant = qdrant_client or QdrantClient(
      url=settings.qdrant_url,
      api_key=settings.qdrant_api_key,
      timeout=5,
    )
    qdrant.get_collection(settings.memory_projection_collection)
    embedding = _build_embedding(settings, ai_service.local_model)
    candidate_index = QdrantMemoryCandidateIndex(
      qdrant,
      embedding,
      collection_name=settings.memory_projection_collection,
      clock=clock,
    )
    projection = QdrantMemoryProjection(
      qdrant,
      collection_name=settings.memory_projection_collection,
      projection_version=settings.memory_projection_version,
    )
    reconciler = MemoryProjectionReconciler(repository, projection, embedding, clock)

  application = MemoryApplication(
    repository,
    signer,
    clock,
    candidate_index=candidate_index,
    policy=policy,
    audit_sink=audit_sink,
    audit_release_sha=settings.release_sha,
  )
  return MemoryRuntime(
    application=application,
    confirmation_signer=signer,
    clock=clock,
    policy=policy,
    reconciler=reconciler,
  )


def _validate_rollout(settings, policy: MemoryPolicy) -> None:
  requested = {
    "write": settings.memory_write_enabled,
    "retrieval": settings.memory_retrieval_enabled,
    "response": settings.memory_response_enabled,
  }
  approved = {
    "write": policy.rollout.write_enabled,
    "retrieval": policy.rollout.retrieval_enabled,
    "response": policy.rollout.response_enabled,
  }
  unapproved = [name for name, enabled in requested.items() if enabled and not approved[name]]
  if unapproved:
    raise ValueError(f"Memory rollout is not policy-approved for: {', '.join(unapproved)}")
  if settings.memory_response_enabled:
    raise ValueError("Memory response augmentation is not implemented")


def _validate_projection_settings(settings, policy: MemoryPolicy) -> None:
  if not is_private_service_url(settings.qdrant_url):
    raise ValueError("Memory Qdrant must use a private-network endpoint")
  collection = settings.memory_projection_collection
  if collection == settings.qdrant_collection_alias:
    raise ValueError("Memory projection must be separate from the knowledge collection")
  if not collection.startswith(policy.projection.qdrant_collection_prefix):
    raise ValueError("Memory projection collection is outside the approved prefix")
  if not settings.memory_projection_version.strip():
    raise ValueError("MEMORY_PROJECTION_VERSION is required")


def _build_embedding(settings, local_model):
  if settings.rag_embedding_model_name is None:
    return MiniLMEmbeddingProvider(local_model, version=settings.embedding_version)
  return SentenceTransformerEmbeddingProvider(
    settings.rag_embedding_model_name,
    revision=settings.rag_embedding_model_revision or "",
    version=settings.embedding_version,
    device=settings.rag_embedding_device,
  )
