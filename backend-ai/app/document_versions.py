from pathlib import Path
import sqlite3
from typing import Protocol


class StaleSourceSequenceError(ValueError):
  """A source update is older than the accepted document version."""


class DocumentVersionStore(Protocol):
  def current(self, tenant_id: str, document_id: str) -> int | None: ...

  def record(self, tenant_id: str, document_id: str, source_sequence: int) -> None: ...


class SqliteDocumentVersionStore:
  """Monotonic document-version registry for the single-consumer SQLite topology."""

  def __init__(self, path: Path):
    self.path = path
    self.path.parent.mkdir(parents=True, exist_ok=True)
    with self._connect() as connection:
      connection.execute(
        """
        CREATE TABLE IF NOT EXISTS document_versions (
          tenant_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
          PRIMARY KEY (tenant_id, document_id)
        )
        """
      )

  def _connect(self):
    connection = sqlite3.connect(self.path, timeout=5)
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = FULL")
    connection.execute("PRAGMA wal_autocheckpoint = 1000")
    return connection

  def current(self, tenant_id: str, document_id: str) -> int | None:
    with self._connect() as connection:
      row = connection.execute(
        "SELECT source_sequence FROM document_versions WHERE tenant_id = ? AND document_id = ?",
        (tenant_id, document_id),
      ).fetchone()
    return int(row[0]) if row else None

  def record(self, tenant_id: str, document_id: str, source_sequence: int) -> None:
    if source_sequence < 0 or source_sequence > 9_223_372_036_854_775_807:
      raise ValueError("source_sequence must fit a non-negative SQLite integer")
    with self._connect() as connection:
      connection.execute("BEGIN IMMEDIATE")
      row = connection.execute(
        "SELECT source_sequence FROM document_versions WHERE tenant_id = ? AND document_id = ?",
        (tenant_id, document_id),
      ).fetchone()
      if row is not None and int(row[0]) > source_sequence:
        raise StaleSourceSequenceError("source_sequence is older than the accepted version")
      connection.execute(
        """
        INSERT INTO document_versions (tenant_id, document_id, source_sequence)
        VALUES (?, ?, ?)
        ON CONFLICT (tenant_id, document_id) DO UPDATE
        SET source_sequence = excluded.source_sequence
        """,
        (tenant_id, document_id, source_sequence),
      )
