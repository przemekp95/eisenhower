from app.rag.ingestion import DeterministicChunker, build_chunk_records
from app.rag.models import SourceDocument


def test_chunking_is_deterministic_and_versioned():
  source = SourceDocument(
    document_id="task-123",
    tenant_id="tenant-a",
    project_id="project-1",
    owner_id="user-1",
    source_type="task",
    source_uri="task://task-123",
    title="Roadmap",
    text="First paragraph.\n\nSecond paragraph with more context.",
    content_version="42",
    acl_subjects=["user:user-1", "project:project-1"],
  )
  chunker = DeterministicChunker(max_chars=32, overlap_chars=8)

  first = build_chunk_records(source, chunker, embedding_version="minilm-v1")
  second = build_chunk_records(source, chunker, embedding_version="minilm-v1")

  assert [chunk.chunk_id for chunk in first] == [chunk.chunk_id for chunk in second]
  assert [chunk.checksum for chunk in first] == [chunk.checksum for chunk in second]
  assert all(chunk.tenant_id == "tenant-a" for chunk in first)
  assert all(chunk.embedding_version == "minilm-v1" for chunk in first)
  assert all(chunk.acl_subjects == ["user:user-1", "project:project-1"] for chunk in first)


def test_content_or_embedding_version_changes_chunk_identity():
  common = dict(
    document_id="doc",
    tenant_id="tenant-a",
    source_type="project_context",
    source_uri="project://1",
    title="Context",
    text="Stable content",
    acl_subjects=["tenant:tenant-a"],
  )
  v1 = SourceDocument(**common, content_version="v1")
  v2 = SourceDocument(**common, content_version="v2")
  chunker = DeterministicChunker(max_chars=100, overlap_chars=0)

  first = build_chunk_records(v1, chunker, embedding_version="embed-v1")
  changed_content = build_chunk_records(v2, chunker, embedding_version="embed-v1")
  changed_embedding = build_chunk_records(v1, chunker, embedding_version="embed-v2")

  assert first[0].chunk_id != changed_content[0].chunk_id
  assert first[0].chunk_id != changed_embedding[0].chunk_id
