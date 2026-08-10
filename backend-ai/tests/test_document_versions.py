import pytest

from app.document_versions import SqliteDocumentVersionStore, StaleSourceSequenceError


def test_document_version_store_is_durable_and_monotonic(tmp_path):
  path = tmp_path / "jobs.sqlite3"
  first = SqliteDocumentVersionStore(path)

  first.record("tenant-a", "doc-1", 2)
  reopened = SqliteDocumentVersionStore(path)

  assert reopened.current("tenant-a", "doc-1") == 2
  with pytest.raises(StaleSourceSequenceError):
    reopened.record("tenant-a", "doc-1", 1)
  assert reopened.current("tenant-a", "doc-1") == 2
