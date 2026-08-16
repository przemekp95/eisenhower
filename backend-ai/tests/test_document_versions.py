import pytest
import sqlite3

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


def test_document_version_store_uses_durable_wal_connection_settings(tmp_path):
  path = tmp_path / "versions.sqlite3"
  store = SqliteDocumentVersionStore(path)

  with sqlite3.connect(path) as connection:
    assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
  with store._connect() as connection:
    assert connection.execute("PRAGMA synchronous").fetchone()[0] == 2
    assert connection.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
    assert connection.execute("PRAGMA wal_autocheckpoint").fetchone()[0] == 1000
