from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.audit import AuditAction, AuditOutcome, SqliteAuditSink
from app.rag.llamaindex_engine import LlamaIndexChunkingEngine
from app.rag.llamaindex_backfill_runtime import _ensure_candidate_is_inactive
from app.rag.llamaindex_cutover_runtime import _load_audit_sink
from app.rag.errors import ProjectionUnavailable
from app.rag.collections import QdrantCollectionManager
from app.rag.migration import (
  CandidateBackfillApplication,
  LlamaIndexCutoverController,
)
from app.rag.models import AccessScope, RetrievalQuery, SourceDocument
from app.rag.qdrant_llamaindex import LlamaIndexQdrantProjection
from qdrant_client import QdrantClient


def source_document(*, tenant_id: str = "tenant-a", sequence: int = 7, text: str | None = None) -> SourceDocument:
  return SourceDocument(
    document_id="doc-1",
    tenant_id=tenant_id,
    project_id="project-1",
    owner_id="user-1",
    source_type="decision",
    source_uri="eisenhower://repository/decision.md",
    title="Migration decision",
    text=text or (
      "MongoDB remains canonical. Qdrant is only a rebuildable projection. "
      "Every projected candidate is revalidated against tenant, project and ACL policy."
    ),
    content_version=f"v{sequence}",
    source_sequence=sequence,
    acl_subjects=["user:user-1", "project:project-1"],
  )


def query() -> RetrievalQuery:
  return RetrievalQuery(
    text="canonical projection",
    limit=2,
    scope=AccessScope(
      tenant_id="tenant-a",
      user_id="user-1",
      project_ids=["project-1"],
    ),
  )


def test_llamaindex_pipeline_maps_nodes_to_deterministic_project_records():
  engine = LlamaIndexChunkingEngine(
    chunk_size=12,
    chunk_overlap=2,
    pipeline_version="llama-sentence-12-2-v1",
  )

  first = engine.build(source_document(), embedding_version="embedding-v2")
  second = engine.build(source_document(), embedding_version="embedding-v2")

  assert first == second
  assert len(first) >= 2
  assert all(chunk.tenant_id == "tenant-a" for chunk in first)
  assert all(chunk.source_sequence == 7 for chunk in first)
  assert all(chunk.embedding_version == "embedding-v2" for chunk in first)
  assert len({chunk.chunk_id for chunk in first}) == len(first)
  assert all(type(chunk).__module__ == "app.rag.models" for chunk in first)


def test_pipeline_namespace_changes_candidate_identity():
  first = LlamaIndexChunkingEngine(
    chunk_size=64,
    chunk_overlap=4,
    pipeline_version="llama-v1",
  ).build(source_document(), embedding_version="embedding-v2")
  second = LlamaIndexChunkingEngine(
    chunk_size=64,
    chunk_overlap=4,
    pipeline_version="llama-v2",
  ).build(source_document(), embedding_version="embedding-v2")

  assert [chunk.text for chunk in first] == [chunk.text for chunk in second]
  assert [chunk.chunk_id for chunk in first] != [chunk.chunk_id for chunk in second]


def test_llamaindex_ingestion_cache_is_persisted_and_rebuildable(tmp_path):
  cache_path = tmp_path / "ingestion-cache.json"
  first_engine = LlamaIndexChunkingEngine(
    chunk_size=64,
    chunk_overlap=4,
    pipeline_version="llama-v1",
    cache_path=cache_path,
  )
  first = first_engine.build(source_document(), embedding_version="embedding-v2")

  second_engine = LlamaIndexChunkingEngine(
    chunk_size=64,
    chunk_overlap=4,
    pipeline_version="llama-v1",
    cache_path=cache_path,
  )
  second = second_engine.build(source_document(), embedding_version="embedding-v2")

  assert cache_path.stat().st_size > 0
  assert second == first


class Embedder:
  version = "embedding-v2"

  def embed(self, texts):
    return [[float(len(text)), float(text.count("a")), 1.0] for text in texts]


def test_native_qdrant_projection_is_isolated_and_returns_only_project_dtos():
  engine = LlamaIndexChunkingEngine(
    chunk_size=64,
    chunk_overlap=4,
    pipeline_version="llama-v1",
  )
  document = source_document()
  chunks = engine.build(document, embedding_version=Embedder.version)
  vectors = Embedder().embed([chunk.text for chunk in chunks])
  projection = LlamaIndexQdrantProjection(
    QdrantClient(location=":memory:"),
    Embedder(),
    collection_name="eisenhower-knowledge-llama-v1-candidate",
  )

  projection.replace_documents([document], chunks, vectors)

  assert projection.projected_chunks("doc-1", "tenant-a") == {
    (chunk.chunk_id, chunk.checksum, chunk.content_version) for chunk in chunks
  }
  hits = projection.retrieve(query())
  assert hits
  assert all(type(item).__module__ == "app.rag.models" for item in hits)
  assert all(item.tenant_id == "tenant-a" for item in hits)
  foreign_query = query().model_copy(
    update={"scope": query().scope.model_copy(update={"tenant_id": "tenant-b"})}
  )
  assert projection.retrieve(foreign_query) == []

  projection.tombstone("doc-1", "tenant-a", "v8", source_sequence=8)
  assert projection.projected_chunks("doc-1", "tenant-a") == set()


def test_native_qdrant_projection_rejects_a_stale_backfill_without_downgrading_nodes():
  engine = LlamaIndexChunkingEngine(chunk_size=64, chunk_overlap=4, pipeline_version="llama-v1")
  projection = LlamaIndexQdrantProjection(
    QdrantClient(location=":memory:"),
    Embedder(),
    collection_name="eisenhower-knowledge-llama-v1-candidate",
  )
  current = source_document(sequence=8, text="Current canonical content remains available.")
  stale = source_document(sequence=7, text="Stale content must never replace it.")
  current_chunks = engine.build(current, embedding_version=Embedder.version)
  stale_chunks = engine.build(stale, embedding_version=Embedder.version)

  projection.replace_documents([current], current_chunks, Embedder().embed([c.text for c in current_chunks]))
  projection.replace_documents([stale], stale_chunks, Embedder().embed([c.text for c in stale_chunks]))

  assert projection.projected_chunks("doc-1", "tenant-a") == {
    (chunk.chunk_id, chunk.checksum, chunk.content_version) for chunk in current_chunks
  }


def test_native_qdrant_projection_rejects_equal_sequence_conflicting_content():
  engine = LlamaIndexChunkingEngine(chunk_size=64, chunk_overlap=4, pipeline_version="llama-v1")
  projection = LlamaIndexQdrantProjection(
    QdrantClient(location=":memory:"),
    Embedder(),
    collection_name="eisenhower-knowledge-llama-v1-candidate",
  )
  first = source_document(sequence=8, text="First content.")
  conflict = source_document(sequence=8, text="Conflicting content.")
  first_chunks = engine.build(first, embedding_version=Embedder.version)
  conflict_chunks = engine.build(conflict, embedding_version=Embedder.version)
  projection.replace_documents([first], first_chunks, Embedder().embed([c.text for c in first_chunks]))

  with pytest.raises(ProjectionUnavailable, match="conflicting sequence"):
    projection.replace_documents(
      [conflict],
      conflict_chunks,
      Embedder().embed([c.text for c in conflict_chunks]),
    )


def test_native_qdrant_projection_ignores_a_stale_tombstone():
  engine = LlamaIndexChunkingEngine(chunk_size=64, chunk_overlap=4, pipeline_version="llama-v1")
  projection = LlamaIndexQdrantProjection(
    QdrantClient(location=":memory:"),
    Embedder(),
    collection_name="eisenhower-knowledge-llama-v1-candidate",
  )
  current = source_document(sequence=8, text="Current content survives stale deletion.")
  chunks = engine.build(current, embedding_version=Embedder.version)
  projection.replace_documents([current], chunks, Embedder().embed([c.text for c in chunks]))

  projection.tombstone("doc-1", "tenant-a", "deleted-v7", source_sequence=7)

  assert projection.projected_chunks("doc-1", "tenant-a") == {
    (chunk.chunk_id, chunk.checksum, chunk.content_version) for chunk in chunks
  }


def test_native_qdrant_projection_accepts_the_guarded_active_alias_after_cutover():
  projection = LlamaIndexQdrantProjection(
    QdrantClient(location=":memory:"),
    Embedder(),
    collection_name="eisenhower-knowledge-active",
  )

  assert projection.collection_name == "eisenhower-knowledge-active"


class CanonicalDocuments:
  def __init__(self, documents):
    self.documents = documents
    self.mutated = False

  def project_documents(self, tenant_id, project_id=None):
    return [
      document for document in self.documents
      if document.tenant_id == tenant_id and (project_id is None or document.project_id == project_id)
    ]

  def stage(self, document):
    del document
    self.mutated = True
    raise AssertionError("backfill must not stage or replace canonical Mongo state")


def test_candidate_backfill_rebuilds_only_the_isolated_projection_without_mutating_mongo():
  documents = CanonicalDocuments([source_document()])
  projection = LlamaIndexQdrantProjection(
    QdrantClient(location=":memory:"),
    Embedder(),
    collection_name="eisenhower-knowledge-llama-v1-candidate",
  )
  engine = LlamaIndexChunkingEngine(
    chunk_size=64,
    chunk_overlap=4,
    pipeline_version="llama-v1",
  )
  backfill = CandidateBackfillApplication(Embedder(), documents, projection, engine)

  result = backfill.run("tenant-a", "project-1")

  assert result == {"documents": 1, "projected": 1, "failed": 0, "tombstoned": 0}
  assert documents.mutated is False
  assert projection.projected_chunks("doc-1", "tenant-a")


def test_candidate_backfill_is_forbidden_after_alias_cutover():
  client = QdrantClient(location=":memory:")
  manager = QdrantCollectionManager(client, alias="knowledge-active", vector_size=3)
  manager.create_version("knowledge-llama-v1-candidate")
  manager.activate("knowledge-llama-v1-candidate", previous_collection=None)

  with pytest.raises(RuntimeError, match="forbidden after alias cutover"):
    _ensure_candidate_is_inactive(
      client,
      alias="knowledge-active",
      candidate_collection="knowledge-llama-v1-candidate",
    )


def test_guarded_alias_cutover_and_rollback_retain_both_physical_collections():
  client = QdrantClient(location=":memory:")
  manager = QdrantCollectionManager(client, alias="knowledge-active", vector_size=3)
  manager.create_version("knowledge-legacy")
  manager.create_version("knowledge-llama-v1-candidate")
  manager.activate("knowledge-legacy", previous_collection=None)
  controller = LlamaIndexCutoverController(
    manager,
    legacy_collection="knowledge-legacy",
    candidate_collection="knowledge-llama-v1-candidate",
  )

  cutover = controller.cutover()
  rollback = controller.rollback()

  assert cutover == {
    "previous_collection": "knowledge-legacy",
    "active_collection": "knowledge-llama-v1-candidate",
  }
  assert rollback == {
    "previous_collection": "knowledge-llama-v1-candidate",
    "active_collection": "knowledge-legacy",
  }
  assert client.collection_exists("knowledge-legacy")
  assert client.collection_exists("knowledge-llama-v1-candidate")


def test_cutover_refuses_an_unexpected_active_alias():
  client = QdrantClient(location=":memory:")
  manager = QdrantCollectionManager(client, alias="knowledge-active", vector_size=3)
  for collection in ("knowledge-other", "knowledge-legacy", "knowledge-llama-v1-candidate"):
    manager.create_version(collection)
  manager.activate("knowledge-other", previous_collection=None)
  controller = LlamaIndexCutoverController(
    manager,
    legacy_collection="knowledge-legacy",
    candidate_collection="knowledge-llama-v1-candidate",
  )

  with pytest.raises(ValueError, match="expected previous|does not match"):
    controller.cutover()


def test_cutover_preflight_verifies_source_and_target_without_switching_alias():
  client = QdrantClient(location=":memory:")
  manager = QdrantCollectionManager(client, alias="knowledge-active", vector_size=3)
  manager.create_version("knowledge-legacy")
  manager.create_version("knowledge-llama-v1-candidate")
  manager.activate("knowledge-legacy", previous_collection=None)
  controller = LlamaIndexCutoverController(
    manager,
    legacy_collection="knowledge-legacy",
    candidate_collection="knowledge-llama-v1-candidate",
  )

  receipt = controller.preflight("cutover")

  assert receipt == {
    "active_collection": "knowledge-legacy",
    "target_collection": "knowledge-llama-v1-candidate",
  }
  assert manager.active_collection() == "knowledge-legacy"


def test_cutover_preflight_fails_when_the_target_collection_is_missing():
  client = QdrantClient(location=":memory:")
  manager = QdrantCollectionManager(client, alias="knowledge-active", vector_size=3)
  manager.create_version("knowledge-legacy")
  manager.activate("knowledge-legacy", previous_collection=None)
  controller = LlamaIndexCutoverController(
    manager,
    legacy_collection="knowledge-legacy",
    candidate_collection="knowledge-llama-v1-candidate",
  )

  with pytest.raises(ValueError, match="Target collection does not exist"):
    controller.preflight("cutover")


def test_applied_cutover_and_rollback_write_durable_audit(tmp_path):
  client = QdrantClient(location=":memory:")
  manager = QdrantCollectionManager(client, alias="knowledge-active", vector_size=3)
  manager.create_version("knowledge-legacy")
  manager.create_version("knowledge-llama-v1-candidate")
  manager.activate("knowledge-legacy", previous_collection=None)
  controller = LlamaIndexCutoverController(
    manager,
    legacy_collection="knowledge-legacy",
    candidate_collection="knowledge-llama-v1-candidate",
  )
  sink = SqliteAuditSink(
    tmp_path / "audit.sqlite3",
    hmac_key=b"task048-cutover-audit-key-at-least-32-bytes",
  )

  controller.apply_audited(
    "cutover", audit_sink=sink, release_sha="d" * 40,
    actor_id="operator", request_id="cutover-request",
  )
  controller.apply_audited(
    "rollback", audit_sink=sink, release_sha="d" * 40,
    actor_id="operator", request_id="rollback-request",
  )

  records = sink.query(limit=10)
  assert [(record.action, record.outcome) for record in records] == [
    (AuditAction.ROLLOUT_DECISION, AuditOutcome.ATTEMPT),
    (AuditAction.ROLLOUT_DECISION, AuditOutcome.SUCCESS),
    (AuditAction.ROLLBACK_DECISION, AuditOutcome.ATTEMPT),
    (AuditAction.ROLLBACK_DECISION, AuditOutcome.SUCCESS),
  ]
  assert manager.active_collection() == "knowledge-legacy"


def test_cutover_compensates_when_success_audit_fails():
  class FailingResultAudit:
    def __init__(self):
      self.calls = 0

    def record(self, _event):
      self.calls += 1
      if self.calls == 2:
        raise RuntimeError("audit unavailable")

  client = QdrantClient(location=":memory:")
  manager = QdrantCollectionManager(client, alias="knowledge-active", vector_size=3)
  manager.create_version("knowledge-legacy")
  manager.create_version("knowledge-llama-v1-candidate")
  manager.activate("knowledge-legacy", previous_collection=None)
  controller = LlamaIndexCutoverController(
    manager,
    legacy_collection="knowledge-legacy",
    candidate_collection="knowledge-llama-v1-candidate",
  )

  with pytest.raises(RuntimeError, match="audit"):
    controller.apply_audited(
      "cutover", audit_sink=FailingResultAudit(), release_sha="d" * 40,
      actor_id="operator", request_id="cutover-request",
    )

  assert manager.active_collection() == "knowledge-legacy"


def test_cutover_cli_requires_complete_durable_audit_for_apply(tmp_path):
  args = SimpleNamespace(
    apply=True,
    audit_database=None,
    audit_key_file=None,
    release_sha=None,
  )
  with pytest.raises(RuntimeError, match="requires --audit-database"):
    _load_audit_sink(args)

  key_path = tmp_path / "audit.key"
  key_path.write_bytes(b"task048-cutover-audit-key-at-least-32-bytes")
  key_path.chmod(0o600)
  args.audit_database = tmp_path / "audit.sqlite3"
  args.audit_key_file = key_path
  args.release_sha = "d" * 40
  sink = _load_audit_sink(args)
  assert sink is not None
  sink.close()
