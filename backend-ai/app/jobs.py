from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from uuid import NAMESPACE_URL, uuid5


ALLOWED_JOB_TYPES = {
  "rag.extract_document",
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


class QueueCapacityExceeded(RuntimeError):
  """Raised before accepting new work when the bounded durable queue is full."""

  def __init__(self):
    super().__init__("Durable job queue capacity has been reached.")


class SqliteJobQueue:
  """Durable, leased command queue for a small single-site deployment."""

  def __init__(self, path: Path, *, max_queued_jobs: int = 1000):
    if max_queued_jobs < 1:
      raise ValueError("Queue capacity must be positive")
    self.path = path
    self.max_queued_jobs = max_queued_jobs
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
      connection.execute("DROP INDEX IF EXISTS jobs_claim_idx")
      connection.execute(
        "CREATE INDEX IF NOT EXISTS jobs_queued_claim_idx "
        "ON jobs(available_at, created_at, job_id) WHERE status = 'queued'"
      )
      connection.execute(
        "CREATE INDEX IF NOT EXISTS jobs_running_claim_idx "
        "ON jobs(lease_expires_at, created_at, job_id) WHERE status = 'running'"
      )
      connection.execute(
        "CREATE INDEX IF NOT EXISTS jobs_terminal_cleanup_idx "
        "ON jobs(updated_at, job_id) WHERE status IN ('completed', 'dead_letter')"
      )
      connection.execute(
        """
        CREATE TABLE IF NOT EXISTS job_terminal_receipts (
          job_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          job_type TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('completed', 'dead_letter')),
          attempts INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_error TEXT
        )
        """
      )
      connection.execute(
        """
        CREATE TABLE IF NOT EXISTS worker_heartbeats (
          worker_id TEXT PRIMARY KEY,
          updated_at TEXT NOT NULL
        )
        """
      )
      connection.execute(
        "CREATE INDEX IF NOT EXISTS worker_heartbeats_cleanup_idx "
        "ON worker_heartbeats(updated_at, worker_id)"
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
    connection = sqlite3.connect(self.path, timeout=5)
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = FULL")
    connection.execute("PRAGMA wal_autocheckpoint = 1000")
    return connection

  def enqueue(self, idempotency_key: str, job_type: str, payload: dict) -> Job:
    if job_type not in ALLOWED_JOB_TYPES:
      raise ValueError("Unsupported job type")
    if not idempotency_key:
      raise ValueError("Idempotency key is required")
    job_id = str(uuid5(NAMESPACE_URL, f"{job_type}:{idempotency_key}"))
    created_at = datetime.now(timezone.utc).isoformat()
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    fingerprint = self._request_fingerprint(job_type, serialized)
    with self._connect() as connection:
      connection.execute("BEGIN IMMEDIATE")
      receipt = connection.execute(
        """
        SELECT job_id, idempotency_key, job_type, request_fingerprint, status,
          attempts, created_at, updated_at, last_error
        FROM job_terminal_receipts WHERE idempotency_key = ?
        """,
        (idempotency_key,),
      ).fetchone()
      if receipt is not None:
        if receipt[2] != job_type or receipt[3] != fingerprint:
          raise JobConflictError()
        return Job(
          job_id=receipt[0],
          idempotency_key=receipt[1],
          job_type=receipt[2],
          payload=payload,
          status=receipt[4],
          attempts=int(receipt[5]),
          created_at=receipt[6],
          updated_at=receipt[7],
          available_at=receipt[7],
          last_error=receipt[8],
        )
      existing = connection.execute(
        f"SELECT {JOB_COLUMNS} FROM jobs WHERE idempotency_key = ?",
        (idempotency_key,),
      ).fetchone()
      if existing is not None:
        existing_payload = json.dumps(
          json.loads(existing[3]), sort_keys=True, separators=(",", ":")
        )
        if existing[2] != job_type or existing_payload != serialized:
          raise JobConflictError()
        return self._row_to_job(existing)
      pending = connection.execute(
        "SELECT COUNT(*) FROM jobs WHERE status IN ('queued', 'running')"
      ).fetchone()[0]
      if int(pending) >= self.max_queued_jobs:
        raise QueueCapacityExceeded()
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

  def counts_by_type_and_status(self) -> dict[tuple[str, str], int]:
    with self._connect() as connection:
      rows = connection.execute(
        "SELECT job_type, status, COUNT(*) FROM jobs GROUP BY job_type, status"
      ).fetchall()
    return {
      (str(job_type), str(status)): int(count)
      for job_type, status, count in rows
    }

  def record_worker_heartbeat(
    self,
    worker_id: str,
    *,
    now: datetime | None = None,
  ) -> None:
    if not worker_id:
      raise ValueError("A worker id is required")
    current = now or datetime.now(timezone.utc)
    with self._connect() as connection:
      connection.execute(
        """
        INSERT INTO worker_heartbeats(worker_id, updated_at) VALUES (?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET updated_at = excluded.updated_at
        """,
        (worker_id, current.isoformat()),
      )

  def latest_worker_heartbeat_age_seconds(
    self,
    *,
    now: datetime | None = None,
  ) -> float | None:
    current = now or datetime.now(timezone.utc)
    with self._connect() as connection:
      row = connection.execute("SELECT MAX(updated_at) FROM worker_heartbeats").fetchone()
    if row is None or row[0] is None:
      return None
    return max(0.0, (current - datetime.fromisoformat(row[0])).total_seconds())

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
        SELECT {JOB_COLUMNS} FROM (
          SELECT {JOB_COLUMNS} FROM jobs
          WHERE status = 'queued' AND available_at <= ?
          UNION ALL
          SELECT {JOB_COLUMNS} FROM jobs
          WHERE status = 'running' AND lease_expires_at <= ?
        )
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

  def prune_terminal_jobs(self, *, before: datetime, limit: int) -> int:
    """Compact terminal jobs to receipts without touching retryable work."""
    self._validate_cleanup_limit(limit)
    with self._connect() as connection:
      connection.execute("BEGIN IMMEDIATE")
      rows = connection.execute(
        """
        SELECT job_id, idempotency_key, job_type, payload_json, status, attempts,
          created_at, updated_at, last_error
        FROM jobs
        WHERE status IN ('completed', 'dead_letter') AND updated_at < ?
        ORDER BY updated_at, job_id
        LIMIT ?
        """,
        (before.isoformat(), limit),
      ).fetchall()
      connection.executemany(
        """
        INSERT INTO job_terminal_receipts (
          job_id, idempotency_key, job_type, request_fingerprint, status,
          attempts, created_at, updated_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
          (
            row[0], row[1], row[2], self._request_fingerprint(row[2], row[3]),
            row[4], row[5], row[6], row[7], row[8],
          )
          for row in rows
        ],
      )
      connection.executemany("DELETE FROM jobs WHERE job_id = ?", [(row[0],) for row in rows])
    return len(rows)

  def prune_stale_worker_heartbeats(self, *, before: datetime, limit: int) -> int:
    """Delete a bounded batch of heartbeat rows older than the supplied cutoff."""
    self._validate_cleanup_limit(limit)
    with self._connect() as connection:
      connection.execute("BEGIN IMMEDIATE")
      cursor = connection.execute(
        """
        DELETE FROM worker_heartbeats WHERE worker_id IN (
          SELECT worker_id FROM worker_heartbeats
          WHERE updated_at < ?
          ORDER BY updated_at, worker_id
          LIMIT ?
        )
        """,
        (before.isoformat(), limit),
      )
    return int(cursor.rowcount)

  @staticmethod
  def _validate_cleanup_limit(limit: int) -> None:
    if not 1 <= limit <= 10_000:
      raise ValueError("Cleanup limit must be between 1 and 10000")

  @staticmethod
  def _request_fingerprint(job_type: str, serialized_payload: str) -> str:
    return sha256(f"{job_type}\0{serialized_payload}".encode("utf-8")).hexdigest()

  def renew_lease(
    self,
    job_id: str,
    worker_id: str,
    *,
    now: datetime | None = None,
    lease_seconds: int = 60,
  ) -> None:
    if not worker_id or lease_seconds < 1:
      raise ValueError("A worker id and positive lease are required")
    current = now or datetime.now(timezone.utc)
    lease_iso = (current + timedelta(seconds=lease_seconds)).isoformat()
    with self._connect() as connection:
      cursor = connection.execute(
        """
        UPDATE jobs SET updated_at = ?, lease_expires_at = ?
        WHERE job_id = ? AND status = 'running' AND worker_id = ?
        """,
        (current.isoformat(), lease_iso, job_id, worker_id),
      )
      if cursor.rowcount != 1:
        raise RuntimeError("Job lease is no longer owned by this worker")

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
