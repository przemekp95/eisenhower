import os
from uuid import uuid4

import pytest

from app.rag.canonical import CanonicalIngestionApplication
from app.rag.llamaindex_engine import LlamaIndexChunkingEngine
from app.rag.models import SourceDocument
from app.rag.mongo_document_store import MongoCanonicalDocumentStore
from app.rag.qdrant_llamaindex import LlamaIndexQdrantProjection


pytestmark = pytest.mark.skipif(
  os.getenv("RUN_LIVE_RAG_TESTS") != "1",
  reason="requires the explicitly enabled local MongoDB and Qdrant runtimes",
)


class DeterministicEmbedding:
  version = "runtime-proof-v1"

  @staticmethod
  def embed(texts):
    return [[float(len(text)), float(index), 1.0] for index, text in enumerate(texts)]


def test_mongo_canonical_store_rebuilds_a_lost_qdrant_collection():
  from pymongo import MongoClient
  from qdrant_client import QdrantClient

  suffix = uuid4().hex
  database_name = f"eisenhower_task011_verify_{suffix}"
  collection_name = f"task011_verify_{suffix}"
  mongo = MongoClient("mongodb://127.0.0.1:27017", serverSelectionTimeoutMS=3_000)
  qdrant = QdrantClient(url="http://127.0.0.1:6333", timeout=5)
  try:
    assert mongo.admin.command("ping")["ok"] == 1.0
    store = MongoCanonicalDocumentStore(mongo[database_name].rag_documents)
    adapter = LlamaIndexQdrantProjection(
      qdrant,
      DeterministicEmbedding(),
      collection_name=collection_name,
    )
    application = CanonicalIngestionApplication(
      DeterministicEmbedding(),
      store,
      adapter,
      LlamaIndexChunkingEngine(
        chunk_size=512,
        chunk_overlap=64,
        pipeline_version="llama-runtime-proof-v1",
      ),
    )
    document = SourceDocument(
      document_id="runtime-doc-1",
      tenant_id="eisenhower-owner",
      project_id="eisenhower",
      owner_id="eisenhower-owner",
      source_type="project_context",
      source_uri="eisenhower://runtime-proof/doc-1",
      title="Runtime proof",
      text="Canonical Mongo content that must survive loss of the vector projection.",
      content_version="runtime-v1",
      source_sequence=1,
      acl_subjects=[
        "tenant:eisenhower-owner",
        "user:eisenhower-owner",
        "project:eisenhower",
      ],
    )

    first = application.ingest([document])
    assert first["projected"] == 1
    persisted = mongo[database_name].rag_documents.find_one({"document_id": document.document_id})
    assert persisted["projection_pending"] is False
    assert len(adapter.projected_chunks(document.document_id, document.tenant_id)) == 1

    qdrant.delete_collection(collection_name=collection_name)
    adapter = LlamaIndexQdrantProjection(
      qdrant,
      DeterministicEmbedding(),
      collection_name=collection_name,
    )
    application.projection = adapter
    assert adapter.projected_chunks(document.document_id, document.tenant_id) == set()

    rebuilt = application.reindex_project(document.tenant_id, document.project_id)
    assert rebuilt == {"documents": 1, "projected": 1, "pending": 0}
    assert len(adapter.projected_chunks(document.document_id, document.tenant_id)) == 1
    assert application.reconcile(document.tenant_id, document.project_id) == {
      "projected": 0,
      "pending": 0,
      "drifted": 0,
    }
  finally:
    mongo.drop_database(database_name)
    if qdrant.collection_exists(collection_name):
      qdrant.delete_collection(collection_name=collection_name)
    qdrant.close()
    mongo.close()
