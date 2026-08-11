from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
from uuid import NAMESPACE_URL, uuid5


ALLOWED_JOB_TYPES = {
  "rag.upsert",
  "rag.tombstone",
  "rag.reindex_project",
  "rag.evaluate",
}

JOB_COLUMNS = (
  "job_id, idempotency_key, job_type, payload_json, status, attempts, "
  "created_at, updated_at, available_at, lease_expires_at, worker_id, last_error"
)


@dataclass(frozen=True)
class Job:
  job_id: str
  idempotency_key: str
  job_type: str
  payload: dict
  status: str
  attempts: int
  created_at: str
  updated_at: str
  available_at: str
  lease_expires_at: str | None = None
  worker_id: str | None = None
  last_error: str | None = None


class JobConflictError(RuntimeError):
  """Raised when an idempotency key is reused for a different command."""

  def __init__(self):
    super().__init__("Idempotency key is already bound to a different job request.")


class SqliteJobQueue:
  """Durable, leased command queue for a small single-site deployment."""

  def __init__(self, path: Path):
    self.path = path
    self.path.parent.mkdir(parents=True, exist_ok=True)
    with self._connect() as connection:
      connection.execute(
        """
        CREATE TABLE IF NOT EXISTS jobs (
          job_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          job_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          available_at TEXT NOT NULL,
          lease_expires_at TEXT,
          worker_id TEXT,
          last_error TEXT
        )
        """
      )
      self._migrate_legacy_schema(connection)
      connection.execute(
        "CREATE INDEX IF NOT EXISTS jobs_claim_idx "
        "ON jobs(status, available_at, lease_expires_at, created_at)"
      )

  @staticmethod
  def _migrate_legacy_schema(connection) -> None:
    columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
    additions = {
      "updated_at": "TEXT",
      "available_at": "TEXT",
      "lease_expires_at": "TEXT",
      "worker_id": "TEXT",
      "last_error": "TEXT",
    }
    for name, sql_type in additions.items():
      if name not in columns:
        connection.execute(f"ALTER TABLE jobs ADD COLUMN {name} {sql_type}")
    connection.execute("UPDATE jobs SET updated_at = created_at WHERE updated_at IS NULL")
    connection.execute("UPDATE jobs SET available_at = created_at WHERE available_at IS NULL")

  def _connect(self):
    return sqlite3.connect(self.path, timeout=5)

  def enqueue(self, idempotency_key: str, job_type: str, payload: dict) -> Job:
    if job_type not in ALLOWED_JOB_TYPES:
      raise ValueError("Unsupported job type")
    if not idempotency_key:
      raise ValueError("Idempotency key is required")
    job_id = str(uuid5(NAMESPACE_URL, f"{job_type}:{idempotency_key}"))
    created_at = datetime.now(timezone.utc).isoformat()
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    with self._connect() as connection:
      connection.execute("BEGIN IMMEDIATE")
      connection.execute(
        """
        INSERT OR IGNORE INTO jobs
        (job_id, idempotency_key, job_type, payload_json, status, attempts,
         created_at, updated_at, available_at)
        VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
        """,
        (job_id, idempotency_key, job_type, serialized, created_at, created_at, created_at),
      )
      row = connection.execute(
        f"SELECT {JOB_COLUMNS} FROM jobs WHERE idempotency_key = ?",
        (idempotency_key,),
      ).fetchone()
      if row is None:
        raise RuntimeError("Enqueued job could not be read back")
      existing_payload = json.dumps(
        json.loads(row[3]),
        sort_keys=True,
        separators=(",", ":"),
      )
      if row[2] != job_type or existing_payload != serialized:
        raise JobConflictError()
    return self._row_to_job(row)

  def get(self, job_id: str) -> Job | None:
    with self._connect() as connection:
      row = connection.execute(
        f"SELECT {JOB_COLUMNS} FROM jobs WHERE job_id = ?",
        (job_id,),
      ).fetchone()
    return self._row_to_job(row) if row else None

  def counts_by_status(self) -> dict[str, int]:
    with self._connect() as connection:
      rows = connection.execute(
        "SELECT status, COUNT(*) FROM jobs GROUP BY status"
      ).fetchall()
    return {str(status): int(count) for status, count in rows}

  def claim_next(
    self,
    worker_id: str,
    *,
    now: datetime | None = None,
    lease_seconds: int = 60,
  ) -> Job | None:
    if not worker_id or lease_seconds < 1:
      raise ValueError("A worker id and positive lease are required")
    current = now or datetime.now(timezone.utc)
    current_iso = current.isoformat()
    lease_iso = (current + timedelta(seconds=lease_seconds)).isoformat()
    with self._connect() as connection:
      connection.execute("BEGIN IMMEDIATE")
      row = connection.execute(
        f"""
        SELECT {JOB_COLUMNS} FROM jobs
        WHERE (status = 'queued' AND available_at <= ?)
           OR (status = 'running' AND lease_expires_at <= ?)
        ORDER BY created_at, job_id
        LIMIT 1
        """,
        (current_iso, current_iso),
      ).fetchone()
      if row is None:
        return None
      connection.execute(
        """
        UPDATE jobs
        SET status = 'running', attempts = attempts + 1, updated_at = ?,
            lease_expires_at = ?, worker_id = ?, last_error = NULL
        WHERE job_id = ?
        """,
        (current_iso, lease_iso, worker_id, row[0]),
      )
      claimed = connection.execute(
        f"SELECT {JOB_COLUMNS} FROM jobs WHERE job_id = ?", (row[0],)
      ).fetchone()
    return self._row_to_job(claimed)

  def complete(self, job_id: str, worker_id: str, *, now: datetime | None = None) -> None:
    self._finish(job_id, worker_id, "completed", None, now=now)

  def fail(
    self,
    job_id: str,
    worker_id: str,
    *,
    error_code: str,
    retry_after_seconds: float,
    dead_letter: bool,
    now: datetime | None = None,
  ) -> None:
    current = now or datetime.now(timezone.utc)
    status = "dead_letter" if dead_letter else "queued"
    available_at = current + timedelta(seconds=max(0.0, retry_after_seconds))
    with self._connect() as connection:
      cursor = connection.execute(
        """
        UPDATE jobs SET status = ?, updated_at = ?, available_at = ?,
          lease_expires_at = NULL, worker_id = NULL, last_error = ?
        WHERE job_id = ? AND status = 'running' AND worker_id = ?
        """,
        (status, current.isoformat(), available_at.isoformat(), error_code, job_id, worker_id),
      )
      if cursor.rowcount != 1:
        raise RuntimeError("Job lease is no longer owned by this worker")

  def _finish(
    self,
    job_id: str,
    worker_id: str,
    status: str,
    error_code: str | None,
    *,
    now: datetime | None,
  ) -> None:
    current = now or datetime.now(timezone.utc)
    with self._connect() as connection:
      cursor = connection.execute(
        """
        UPDATE jobs SET status = ?, updated_at = ?, lease_expires_at = NULL,
          worker_id = NULL, last_error = ?
        WHERE job_id = ? AND status = 'running' AND worker_id = ?
        """,
        (status, current.isoformat(), error_code, job_id, worker_id),
      )
      if cursor.rowcount != 1:
        raise RuntimeError("Job lease is no longer owned by this worker")

  @staticmethod
  def _row_to_job(row) -> Job:
    return Job(
      job_id=row[0], idempotency_key=row[1], job_type=row[2], payload=json.loads(row[3]),
      status=row[4], attempts=int(row[5]), created_at=row[6], updated_at=row[7],
      available_at=row[8], lease_expires_at=row[9], worker_id=row[10], last_error=row[11],
    )
