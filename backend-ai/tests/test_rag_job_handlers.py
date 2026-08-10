from hashlib import sha256
import json

import pytest

from app.job_worker import PermanentJobError
from app.rag.job_handlers import RagJobHandlers


class RecordingIngestion:
  def __init__(self):
    self.documents = []
    self.tombstones = []
    self.embedding_provider = type("Embedding", (), {"version": "minilm-v1"})()

  def ingest(self, documents):
    self.documents.extend(documents)

  def tombstone(self, document_ids, *, tenant_id, content_version):
    self.tombstones.append((document_ids, tenant_id, content_version))


class RecordingVersions:
  def __init__(self):
    self.versions = {}

  def current(self, tenant_id, document_id):
    return self.versions.get((tenant_id, document_id))

  def record(self, tenant_id, document_id, source_sequence):
    self.versions[(tenant_id, document_id)] = source_sequence


def checksum(value) -> str:
  canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
  return "sha256:" + sha256(canonical.encode()).hexdigest()


def test_upsert_validates_versions_checksum_tenant_and_maps_acl():
  ingestion = RecordingIngestion()
  handlers = RagJobHandlers(ingestion, RecordingVersions(), chunking_version="char-v1")
  documents = [{
    "document_id": "doc-1",
    "source_type": "note",
    "title": "Plan",
    "content": "Trusted project context",
    "source_uri": "eisenhower://notes/doc-1",
    "acl": {"owner_id": "user-1", "reader_ids": ["user-2"]},
  }]

  handlers.upsert({
    "tenant_id": "tenant-a",
    "project_id": "project-a",
    "source_version": "v7",
    "source_sequence": 7,
    "embedding_version": "minilm-v1",
    "chunking_version": "char-v1",
    "content_checksum": checksum(documents),
    "documents": documents,
  })

  document = ingestion.documents[0]
  assert document.tenant_id == "tenant-a"
  assert document.content_version == "v7"
  assert set(document.acl_subjects) == {
    "user:user-1", "user:user-2", "project:project-a",
  }


@pytest.mark.parametrize("field,value", [
  ("embedding_version", "other"),
  ("chunking_version", "other"),
  ("content_checksum", "sha256:" + ("0" * 64)),
  ("source_sequence", -1),
])
def test_upsert_rejects_contract_drift(field, value):
  ingestion = RecordingIngestion()
  handlers = RagJobHandlers(ingestion, RecordingVersions(), chunking_version="char-v1")
  documents = [{
    "document_id": "doc-1", "source_type": "note", "title": "Plan",
    "content": "context", "acl": {"owner_id": "user-1"},
  }]
  payload = {
    "tenant_id": "tenant-a", "project_id": "project-a", "source_version": "v1",
    "source_sequence": 1,
    "embedding_version": "minilm-v1", "chunking_version": "char-v1",
    "content_checksum": checksum(documents), "documents": documents,
  }
  payload[field] = value

  with pytest.raises(PermanentJobError):
    handlers.upsert(payload)


def test_tombstone_is_tenant_scoped_and_reindex_evaluation_are_explicit_callbacks():
  ingestion = RecordingIngestion()
  calls = []
  handlers = RagJobHandlers(
    ingestion,
    RecordingVersions(),
    chunking_version="char-v1",
    reindex_project=lambda payload: calls.append(("reindex", payload["project_id"])),
    evaluate=lambda payload: calls.append(("evaluate", payload["dataset_version"])),
  )

  handlers.tombstone({
    "tenant_id": "tenant-a", "source_version": "v9", "source_sequence": 9,
    "document_ids": ["doc-1"],
  })
  handlers.reindex_project({"project_id": "project-a"})
  handlers.evaluate({"dataset_version": "gold-v1"})

  assert ingestion.tombstones == [(["doc-1"], "tenant-a", "v9")]
  assert calls == [("reindex", "project-a"), ("evaluate", "gold-v1")]


def test_stale_upsert_cannot_replace_a_newer_document_version():
  ingestion = RecordingIngestion()
  versions = RecordingVersions()
  handlers = RagJobHandlers(ingestion, versions, chunking_version="char-v1")

  def payload(sequence, content):
    documents = [{
      "document_id": "doc-1", "source_type": "note", "title": "Plan",
      "content": content, "acl": {"owner_id": "user-1"},
    }]
    return {
      "tenant_id": "tenant-a", "source_version": f"opaque-{sequence}",
      "source_sequence": sequence, "embedding_version": "minilm-v1",
      "chunking_version": "char-v1", "content_checksum": checksum(documents),
      "documents": documents,
    }

  handlers.upsert(payload(2, "newer"))
  handlers.upsert(payload(1, "stale"))

  assert [document.text for document in ingestion.documents] == ["newer"]
  assert versions.current("tenant-a", "doc-1") == 2


def test_stale_upsert_cannot_resurrect_a_newer_tombstone():
  ingestion = RecordingIngestion()
  versions = RecordingVersions()
  handlers = RagJobHandlers(ingestion, versions, chunking_version="char-v1")

  handlers.tombstone({
    "tenant_id": "tenant-a", "source_version": "deleted", "source_sequence": 3,
    "document_ids": ["doc-1"],
  })
  documents = [{
    "document_id": "doc-1", "source_type": "note", "title": "Old",
    "content": "stale", "acl": {"owner_id": "user-1"},
  }]
  handlers.upsert({
    "tenant_id": "tenant-a", "source_version": "old", "source_sequence": 2,
    "embedding_version": "minilm-v1", "chunking_version": "char-v1",
    "content_checksum": checksum(documents), "documents": documents,
  })

  assert ingestion.documents == []
  assert versions.current("tenant-a", "doc-1") == 3
