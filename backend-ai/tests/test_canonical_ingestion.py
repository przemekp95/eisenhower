from app.rag.canonical import (
  CanonicalDocumentState,
  CanonicalIngestionApplication,
  CanonicalWriteStatus,
)
from app.rag.errors import ProjectionUnavailable
from app.rag.ingestion import DeterministicChunker, build_chunk_records
from app.rag.models import SourceDocument


class Embedder:
  version = "minilm-v1"

  def embed(self, texts):
    return [[float(index)] for index, _ in enumerate(texts)]


class Store:
  def __init__(self):
    self.documents = {}
    self.pending = set()
    self.events = []

  def stage(self, document):
    self.events.append("stage")
    key = (document.tenant_id, document.document_id)
    current = self.documents.get(key)
    if current and document.source_sequence < current.source_sequence:
      return CanonicalWriteStatus.STALE
    if current and document.source_sequence == current.source_sequence:
      return CanonicalWriteStatus.DUPLICATE if document.content_checksum == current.content_checksum else CanonicalWriteStatus.CONFLICT
    self.documents[key] = document
    self.pending.add(key)
    return CanonicalWriteStatus.ACCEPTED

  def mark_projected(self, document):
    self.events.append("projected")
    self.pending.discard((document.tenant_id, document.document_id))
    return True

  def pending_documents(self, tenant_id, project_id=None):
    del project_id
    return [self.documents[key] for key in self.pending if key[0] == tenant_id]

  def get(self, tenant_id, document_id):
    return self.documents.get((tenant_id, document_id))

  def retrieval_state(self, tenant_id, document_id):
    document = self.get(tenant_id, document_id)
    if document is None:
      return None
    return CanonicalDocumentState(
      document,
      projection_pending=(tenant_id, document_id) in self.pending,
    )

  def project_documents(self, tenant_id, project_id=None):
    return [
      item for (item_tenant, _), item in self.documents.items()
      if item_tenant == tenant_id and (project_id is None or item.project_id == project_id)
    ]


class Projection:
  def __init__(self, store, fail=False):
    self.store = store
    self.fail = fail
    self.documents = []
    self.tombstones = []
    self.chunks = {}

  def replace_documents(self, documents, chunks, vectors):
    del vectors
    assert all((document.tenant_id, document.document_id) in self.store.documents for document in documents)
    if self.fail:
      raise ProjectionUnavailable("qdrant unavailable")
    self.documents.extend(documents)
    for document in documents:
      self.chunks[(document.tenant_id, document.document_id)] = {
        (chunk.chunk_id, chunk.checksum, chunk.content_version)
        for chunk in chunks
      }

  def tombstone(self, document_id, tenant_id, content_version):
    if self.fail:
      raise ProjectionUnavailable("qdrant unavailable")
    self.tombstones.append((document_id, tenant_id, content_version))
    self.chunks[(tenant_id, document_id)] = set()

  def projected_chunks(self, document_id, tenant_id):
    if self.fail:
      raise ProjectionUnavailable("qdrant unavailable")
    return self.chunks.get((tenant_id, document_id), set())


def document(sequence=1, text="Reviewed decision"):
  return SourceDocument(
    document_id="doc-1", tenant_id="tenant-1", project_id="project-1", owner_id="user-1",
    source_type="decision", source_uri="eisenhower://repository/decision.md", title="Decision",
    text=text, content_version=f"v{sequence}", source_sequence=sequence,
    acl_subjects=["tenant:tenant-1", "project:project-1"],
  )


def test_canonical_document_is_staged_before_projection_and_marked_complete():
  store = Store()
  projection = Projection(store)
  app = CanonicalIngestionApplication(Embedder(), store, projection)
  result = app.ingest([document()])
  assert result == {"accepted": 1, "duplicate": 0, "stale": 0, "conflict": 0, "projected": 1, "pending": 0, "embedding_version": "minilm-v1"}
  assert store.events == ["stage", "projected"]


def test_projection_failure_leaves_canonical_document_pending_for_reconciliation():
  store = Store()
  app = CanonicalIngestionApplication(Embedder(), store, Projection(store, fail=True))
  result = app.ingest([document()])
  assert result["accepted"] == 1
  assert result["projected"] == 0
  assert result["pending"] == 1
  assert store.pending_documents("tenant-1", "project-1")[0].document_id == "doc-1"


def test_stale_duplicate_and_conflicting_sequences_never_reach_projection():
  store = Store()
  projection = Projection(store)
  app = CanonicalIngestionApplication(Embedder(), store, projection)
  app.ingest([document(sequence=2)])
  result = app.ingest([document(sequence=1), document(sequence=2), document(sequence=2, text="conflict")])
  assert result["stale"] == 1
  assert result["duplicate"] == 1
  assert result["conflict"] == 1
  assert len(projection.documents) == 1


def test_reconciliation_projects_a_previously_staged_pending_document():
  store = Store()
  projection = Projection(store, fail=True)
  app = CanonicalIngestionApplication(Embedder(), store, projection)
  app.ingest([document()])
  projection.fail = False

  assert app.reconcile("tenant-1", "project-1") == {"projected": 1, "pending": 0, "drifted": 0}
  assert store.pending == set()


def test_retrying_the_same_command_reprojects_its_pending_canonical_document():
  store = Store()
  projection = Projection(store, fail=True)
  app = CanonicalIngestionApplication(Embedder(), store, projection)
  first = app.ingest([document()])
  projection.fail = False

  retried = app.ingest([document()])

  assert first["pending"] == 1
  assert retried["duplicate"] == 1
  assert retried["projected"] == 1
  assert retried["pending"] == 0
  assert store.pending == set()


def test_reconciliation_repairs_projection_drift_even_when_canonical_is_not_pending():
  store = Store()
  projection = Projection(store)
  app = CanonicalIngestionApplication(Embedder(), store, projection)
  app.ingest([document()])
  projection.chunks.clear()

  assert app.reconcile("tenant-1", "project-1") == {"projected": 1, "pending": 0, "drifted": 1}


def test_forced_reindex_projects_every_current_document_after_collection_loss():
  store = Store()
  projection = Projection(store)
  app = CanonicalIngestionApplication(Embedder(), store, projection)
  app.ingest([document()])
  projection.documents.clear()
  projection.chunks.clear()

  assert app.reindex_project("tenant-1", "project-1") == {"documents": 1, "projected": 1, "pending": 0}
  expected = build_chunk_records(document(), DeterministicChunker(), embedding_version="minilm-v1")
  assert projection.chunks[("tenant-1", "doc-1")] == {
    (chunk.chunk_id, chunk.checksum, chunk.content_version) for chunk in expected
  }


def test_programming_errors_are_not_silently_converted_to_pending_state():
  store = Store()

  class BrokenProjection(Projection):
    def replace_documents(self, documents, chunks, vectors):
      raise ValueError("invalid adapter contract")

  app = CanonicalIngestionApplication(Embedder(), store, BrokenProjection(store))
  try:
    app.ingest([document()])
  except ValueError as error:
    assert str(error) == "invalid adapter contract"
  else:
    raise AssertionError("programming error was swallowed")


def test_tombstone_is_canonical_and_projected_without_retaining_content():
  store = Store()
  projection = Projection(store)
  app = CanonicalIngestionApplication(Embedder(), store, projection)
  app.ingest([document(sequence=1, text="private content")])

  app.tombstone(["doc-1"], tenant_id="tenant-1", content_version="deleted-v2", source_sequence=2)

  tombstone = store.get("tenant-1", "doc-1")
  assert tombstone.deleted is True
  assert tombstone.text == ""
  assert "private content" not in repr(tombstone)
  assert projection.tombstones == [("doc-1", "tenant-1", "deleted-v2")]
