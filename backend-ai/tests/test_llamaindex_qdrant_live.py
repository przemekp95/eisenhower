from __future__ import annotations

import os
from uuid import uuid4

import pytest
from qdrant_client import QdrantClient, models as qmodels

from app.audit import SqliteAuditSink
from app.rag.collections import QdrantCollectionManager
from app.rag.llamaindex_engine import LlamaIndexChunkingEngine
from app.rag.migration import LlamaIndexCutoverController
from app.rag.models import AccessScope, RetrievalQuery, SourceDocument
from app.rag.qdrant_llamaindex import LlamaIndexQdrantProjection


QDRANT_URL = os.environ.get("EISENHOWER_TEST_QDRANT_URL")
pytestmark = pytest.mark.skipif(not QDRANT_URL, reason="isolated live Qdrant URL not supplied")


class Embedder:
  version = "task048-live-v1"

  def embed(self, texts):
    return [[float(len(text)), float(text.count("a")), 1.0] for text in texts]


def test_live_compatible_qdrant_candidate_round_trip_and_cleanup():
  collection = "eisenhower-task048-live-candidate"
  client = QdrantClient(url=QDRANT_URL, timeout=5)
  assert not client.collection_exists(collection)
  document = SourceDocument(
    document_id="live-doc",
    tenant_id="tenant-live",
    project_id="project-live",
    owner_id="user-live",
    source_type="decision",
    source_uri="eisenhower://live/decision",
    title="Live candidate",
    text="Mongo is canonical and Qdrant is a candidate projection.",
    content_version="v1",
    source_sequence=1,
    acl_subjects=["user:user-live", "project:project-live"],
  )
  engine = LlamaIndexChunkingEngine(
    chunk_size=64,
    chunk_overlap=4,
    pipeline_version="task048-live-pipeline-v1",
  )
  chunks = engine.build(document, embedding_version=Embedder.version)
  projection = LlamaIndexQdrantProjection(
    client,
    Embedder(),
    collection_name=collection,
  )
  try:
    projection.replace_documents([document], chunks, Embedder().embed([chunk.text for chunk in chunks]))
    hits = projection.retrieve(
      RetrievalQuery(
        text="canonical projection",
        limit=2,
        scope=AccessScope(
          tenant_id="tenant-live",
          user_id="user-live",
          project_ids=["project-live"],
        ),
      )
    )
    assert hits and all(hit.tenant_id == "tenant-live" for hit in hits)
    projection.tombstone("live-doc", "tenant-live", "v2", source_sequence=2)
    assert projection.projected_chunks("live-doc", "tenant-live") == set()
  finally:
    if client.collection_exists(collection):
      client.delete_collection(collection)


def test_live_guarded_alias_cutover_serves_llamaindex_and_rolls_back(tmp_path):
  suffix = uuid4().hex
  legacy = f"task048-{suffix}-legacy"
  candidate = f"task048-{suffix}-llama-candidate"
  alias = f"task048-{suffix}-active"
  client = QdrantClient(url=QDRANT_URL, timeout=5)
  manager = QdrantCollectionManager(client, alias=alias, vector_size=3)
  document = SourceDocument(
    document_id="cutover-doc",
    tenant_id="tenant-live",
    project_id="project-live",
    owner_id="user-live",
    source_type="decision",
    source_uri="eisenhower://live/cutover",
    title="Cutover candidate",
    text="LlamaIndex candidate is available through the guarded alias.",
    content_version="v1",
    source_sequence=1,
    acl_subjects=["user:user-live", "project:project-live"],
  )
  engine = LlamaIndexChunkingEngine(
    chunk_size=64,
    chunk_overlap=4,
    pipeline_version="task048-live-pipeline-v1",
  )
  chunks = engine.build(document, embedding_version=Embedder.version)
  candidate_projection = LlamaIndexQdrantProjection(
    client,
    Embedder(),
    collection_name=candidate,
  )
  audit_sink = None
  try:
    manager.create_version(legacy)
    client.upsert(
      collection_name=legacy,
      points=[qmodels.PointStruct(id=1, vector=[1.0, 0.0, 0.0], payload={"engine": "legacy"})],
      wait=True,
    )
    manager.activate(legacy, previous_collection=None)
    candidate_projection.replace_documents(
      [document],
      chunks,
      Embedder().embed([chunk.text for chunk in chunks]),
    )
    controller = LlamaIndexCutoverController(
      manager,
      legacy_collection=legacy,
      candidate_collection=candidate,
    )
    audit_sink = SqliteAuditSink(
      tmp_path / "audit.sqlite3",
      hmac_key=b"task048-live-cutover-audit-key-at-least-32-bytes",
    )

    controller.apply_audited(
      "cutover", audit_sink=audit_sink, release_sha="d" * 40,
      actor_id="live-operator", request_id="live-cutover",
    )
    active_projection = LlamaIndexQdrantProjection(client, Embedder(), collection_name=alias)
    hits = active_projection.retrieve(RetrievalQuery(
      text="guarded alias",
      limit=2,
      score_threshold=-1,
      scope=AccessScope(
        tenant_id="tenant-live",
        user_id="user-live",
        project_ids=["project-live"],
      ),
    ))
    assert [hit.document_id for hit in hits] == ["cutover-doc"]

    controller.apply_audited(
      "rollback", audit_sink=audit_sink, release_sha="d" * 40,
      actor_id="live-operator", request_id="live-rollback",
    )
    assert manager.active_collection() == legacy
    legacy_hits = client.query_points(
      collection_name=alias,
      query=[1.0, 0.0, 0.0],
      limit=1,
    ).points
    assert legacy_hits[0].payload == {"engine": "legacy"}
    assert client.collection_exists(candidate)
  finally:
    if audit_sink is not None:
      audit_sink.close()
    if manager.active_collection() in {legacy, candidate}:
      client.update_collection_aliases(change_aliases_operations=[
        qmodels.DeleteAliasOperation(delete_alias=qmodels.DeleteAlias(alias_name=alias))
      ])
    for collection in (candidate, legacy):
      if client.collection_exists(collection):
        client.delete_collection(collection)
    client.close()
