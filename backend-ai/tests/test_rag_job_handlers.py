from hashlib import sha256
from datetime import datetime, timedelta, timezone
import json

import pytest

from app.job_worker import JobWorker, PermanentJobError
from app.jobs import ALLOWED_JOB_TYPES, SqliteJobQueue
from app.rag.errors import ProjectionUnavailable
from app.rag.job_handlers import RagJobHandlers


class RecordingIngestion:
  def __init__(self, result=None):
    self.documents = []
    self.tombstones = []
    self.result = result
    self.embedding_provider = type("Embedding", (), {"version": "minilm-v1"})()

  def ingest(self, documents):
    self.documents.extend(documents)
    return self.result

  def tombstone(self, document_ids, *, tenant_id, content_version, source_sequence):
    self.tombstones.append((document_ids, tenant_id, content_version, source_sequence))
    return self.result


class RecordingVersions:
  def __init__(self):
    self.versions = {}

  def current(self, tenant_id, document_id):
    return self.versions.get((tenant_id, document_id))

  def record(self, tenant_id, document_id, source_sequence):
    self.versions[(tenant_id, document_id)] = source_sequence


def test_handler_registry_exactly_matches_queue_allowlist():
  handlers = RagJobHandlers(RecordingIngestion(), None, chunking_version="char-v1")
  assert set(handlers.registry) == ALLOWED_JOB_TYPES


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

  assert ingestion.tombstones == [(["doc-1"], "tenant-a", "v9", 9)]
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

  assert not ingestion.documents
  assert versions.current("tenant-a", "doc-1") == 3


def test_upsert_keeps_projection_pending_observable_and_does_not_advance_version():
  ingestion = RecordingIngestion({"accepted": 1, "projected": 0, "pending": 1})
  versions = RecordingVersions()
  handlers = RagJobHandlers(ingestion, versions, chunking_version="char-v1")
  documents = [{
    "document_id": "doc-1", "source_type": "note", "title": "Plan",
    "content": "context", "acl": {"owner_id": "user-1"},
  }]

  with pytest.raises(ProjectionUnavailable, match="pending"):
    handlers.upsert({
      "tenant_id": "tenant-a", "source_version": "v1", "source_sequence": 1,
      "embedding_version": "minilm-v1", "chunking_version": "char-v1",
      "content_checksum": checksum(documents), "documents": documents,
    })

  assert versions.current("tenant-a", "doc-1") is None


def test_tombstone_keeps_projection_pending_observable_and_does_not_advance_version():
  ingestion = RecordingIngestion({"accepted": 1, "projected": 0, "pending": 1})
  versions = RecordingVersions()
  handlers = RagJobHandlers(ingestion, versions, chunking_version="char-v1")

  with pytest.raises(ProjectionUnavailable, match="pending"):
    handlers.tombstone({
      "tenant_id": "tenant-a", "source_version": "deleted-v2", "source_sequence": 2,
      "document_ids": ["doc-1"],
    })

  assert versions.current("tenant-a", "doc-1") is None


def test_worker_retries_observable_pending_projection_and_completes_after_recovery(tmp_path):
  class RecoveringIngestion(RecordingIngestion):
    def __init__(self):
      super().__init__()
      self.results = [
        {"accepted": 1, "projected": 0, "pending": 1},
        {"duplicate": 1, "projected": 1, "pending": 0},
      ]

    def ingest(self, documents):
      self.documents.extend(documents)
      return self.results.pop(0)

  ingestion = RecoveringIngestion()
  handlers = RagJobHandlers(ingestion, None, chunking_version="char-v1")
  queue = SqliteJobQueue(tmp_path / "jobs.sqlite3")
  documents = [{
    "document_id": "doc-1", "source_type": "note", "title": "Plan",
    "content": "context", "acl": {"owner_id": "user-1"},
  }]
  job = queue.enqueue("event-1", "rag.upsert", {
    "tenant_id": "tenant-a", "source_version": "v1", "source_sequence": 1,
    "embedding_version": "minilm-v1", "chunking_version": "char-v1",
    "content_checksum": checksum(documents), "documents": documents,
  })
  worker = JobWorker(
    queue,
    handlers.registry,
    base_backoff_seconds=1,
    max_backoff_seconds=1,
    random_value=lambda: 0,
  )
  now = datetime.now(timezone.utc)

  assert worker.run_once(worker_id="worker-1", now=now) is True
  pending = queue.get(job.job_id)
  assert pending.status == "queued"
  assert pending.last_error == "ProjectionUnavailable"

  assert worker.run_once(worker_id="worker-1", now=now + timedelta(seconds=1)) is True
  completed = queue.get(job.job_id)
  assert completed.status == "completed"
  assert completed.attempts == 2
