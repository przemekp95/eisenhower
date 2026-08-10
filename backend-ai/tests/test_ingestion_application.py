from app.rag.ingestion import DeterministicChunker, IngestionApplication
from app.rag.models import SourceDocument


class Embedder:
  version = "minilm-v1"

  def embed(self, texts):
    return [[float(len(text))] for text in texts]


class Sink:
  def __init__(self):
    self.upserts = []
    self.tombstones = []

  def upsert(self, chunks, vectors):
    self.upserts.append((chunks, vectors))

  def tombstone(self, document_id, tenant_id, content_version):
    self.tombstones.append((document_id, tenant_id, content_version))


def test_ingestion_application_chunks_embeds_and_writes_acl_metadata():
  sink = Sink()
  app = IngestionApplication(Embedder(), sink, DeterministicChunker(max_chars=100, overlap_chars=0))
  document = SourceDocument(
    document_id="doc-1",
    tenant_id="tenant-a",
    project_id="project-1",
    owner_id="user-1",
    source_type="runbook",
    source_uri="runbook://1",
    title="Incident",
    text="Approved recovery procedure",
    content_version="v1",
    acl_subjects=["user:user-1", "project:project-1"],
  )

  result = app.ingest([document])

  chunks, vectors = sink.upserts[0]
  assert result == {"documents": 1, "chunks": 1, "embedding_version": "minilm-v1"}
  assert chunks[0].acl_subjects == ["user:user-1", "project:project-1"]
  assert vectors == [[27.0]]


def test_ingestion_application_creates_versioned_tombstones():
  sink = Sink()
  app = IngestionApplication(Embedder(), sink)

  app.tombstone(["doc-1", "doc-2"], tenant_id="tenant-a", content_version="v2")

  assert sink.tombstones == [
    ("doc-1", "tenant-a", "v2"),
    ("doc-2", "tenant-a", "v2"),
  ]
