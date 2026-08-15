from __future__ import annotations

import argparse
import json

from qdrant_client import QdrantClient

from ..config import load_settings
from .adapters import SentenceTransformerEmbeddingProvider
from .bootstrap import is_private_mongodb_uri, is_private_service_url
from .llamaindex_engine import LlamaIndexChunkingEngine
from .migration import CandidateBackfillApplication
from .mongo_document_store import MongoCanonicalDocumentStore
from .qdrant_llamaindex import LlamaIndexQdrantProjection


def _ensure_candidate_is_inactive(client, *, alias: str, candidate_collection: str) -> None:
  active = [
    str(item.collection_name)
    for item in client.get_aliases().aliases
    if item.alias_name == alias
  ]
  if len(active) > 1:
    raise RuntimeError("Qdrant returned duplicate active aliases")
  if active == [candidate_collection]:
    raise RuntimeError("candidate backfill is forbidden after alias cutover")


def main() -> int:
  parser = argparse.ArgumentParser(description="Backfill an isolated LlamaIndex candidate projection")
  parser.add_argument("--tenant", required=True)
  parser.add_argument("--project")
  args = parser.parse_args()
  settings = load_settings()
  if not settings.rag_embedding_model_name or not settings.rag_embedding_model_revision:
    raise SystemExit("candidate backfill requires an explicitly pinned RAG embedding model")
  if not settings.mongodb_uri or not is_private_mongodb_uri(settings.mongodb_uri):
    raise SystemExit("candidate backfill requires a private MongoDB URI")
  if not is_private_service_url(settings.qdrant_url):
    raise SystemExit("candidate backfill requires a private Qdrant endpoint")

  from pymongo import MongoClient

  mongo_client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=5_000)
  mongo_client.admin.command("ping")
  canonical_store = MongoCanonicalDocumentStore(
    mongo_client[settings.mongodb_database][settings.canonical_documents_collection]
  )
  embedding = SentenceTransformerEmbeddingProvider(
    settings.rag_embedding_model_name,
    revision=settings.rag_embedding_model_revision,
    version=settings.embedding_version,
    device=settings.rag_embedding_device,
  )
  qdrant = QdrantClient(url=settings.qdrant_url, api_key=settings.qdrant_api_key, timeout=10)
  try:
    _ensure_candidate_is_inactive(
      qdrant,
      alias=settings.qdrant_collection_alias,
      candidate_collection=settings.llamaindex_candidate_collection,
    )
    projection = LlamaIndexQdrantProjection(
      qdrant,
      embedding,
      collection_name=settings.llamaindex_candidate_collection,
    )
    chunking = LlamaIndexChunkingEngine(
      chunk_size=settings.llamaindex_chunk_size,
      chunk_overlap=settings.llamaindex_chunk_overlap,
      pipeline_version=settings.llamaindex_pipeline_version,
      cache_path=settings.llamaindex_cache_path,
    )
    result = CandidateBackfillApplication(embedding, canonical_store, projection, chunking).run(
      args.tenant,
      args.project,
    )
    print(json.dumps(result, sort_keys=True))
    return 2 if result["failed"] else 0
  finally:
    qdrant.close()
    mongo_client.close()


if __name__ == "__main__":
  raise SystemExit(main())
