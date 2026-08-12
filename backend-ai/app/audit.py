from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime
from enum import Enum
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
from typing import Callable


GENESIS_HASH = "0" * 64
MAX_QUERY_LIMIT = 500
MAX_RETENTION_LIMIT = 1_000
_OPAQUE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SERVICE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
_RELEASE_SHA = re.compile(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")


class AuditAction(str, Enum):
  ADMIN_OPERATION = "admin_operation"
  MEMORY_CHANGE = "memory_change"
  CONSENT_CHANGE = "consent_change"
  INGEST = "ingest"
  REINDEX = "reindex"
  MCP_TOOL_USE = "mcp_tool_use"
  ROLLOUT_DECISION = "rollout_decision"
  ROLLBACK_DECISION = "rollback_decision"
  AUTH_REJECTION = "auth_rejection"
  ACL_REJECTION = "acl_rejection"
  SECURITY_ANOMALY = "security_anomaly"


class AuditOutcome(str, Enum):
  ATTEMPT = "attempt"
  SUCCESS = "success"
  REJECTED = "rejected"
  ERROR = "error"


class AuditError(RuntimeError):
  """Base error for the fail-closed audit boundary."""


class AuditConflict(AuditError):
  """Raised when an event id is reused for different safe metadata."""


class AuditIntegrityError(AuditError):
  """Raised when the retained ledger or its retention anchor was changed."""


class AuditWriteError(AuditError):
  """Raised when a required audit event cannot be durably appended."""


def _validate_identifier(name: str, value: str) -> None:
  if not isinstance(value, str) or _OPAQUE_ID.fullmatch(value) is None:
    raise ValueError(f"{name} must be a bounded opaque identifier")


@dataclass(frozen=True)
class AuditEvent:
  """Sensitive identifiers accepted only for immediate HMAC pseudonymization."""

  service: str
  release_sha: str
  event_id: str
  request_id: str
  action: AuditAction
  outcome: AuditOutcome
  tenant_id: str
  actor_id: str
  resource_id: str | None = None

  def __post_init__(self) -> None:
    if not isinstance(self.action, AuditAction):
      raise ValueError("action must be an AuditAction")
    if not isinstance(self.outcome, AuditOutcome):
      raise ValueError("outcome must be an AuditOutcome")
    if not isinstance(self.service, str) or _SERVICE.fullmatch(self.service) is None:
      raise ValueError("service must use the closed service-name format")
    if not isinstance(self.release_sha, str) or _RELEASE_SHA.fullmatch(self.release_sha) is None:
      raise ValueError("release_sha must be a full lowercase Git or artifact digest")
    _validate_identifier("event_id", self.event_id)
    _validate_identifier("request_id", self.request_id)
    for name, value in (("tenant_id", self.tenant_id), ("actor_id", self.actor_id)):
      if not isinstance(value, str) or not value or len(value) > 256:
        raise ValueError(f"{name} must be present and bounded")
    if self.resource_id is not None and (
      not isinstance(self.resource_id, str) or not self.resource_id or len(self.resource_id) > 256
    ):
      raise ValueError("resource_id must be absent or bounded")

  def model_copy(self, **updates) -> AuditEvent:
    """Small immutable-copy helper used by callers without accepting open metadata."""
    return replace(self, **updates)


@dataclass(frozen=True)
class StoredAuditEvent:
  sequence: int
  occurred_at: str
  service: str
  release_sha: str
  event_id: str
  request_id: str
  action: AuditAction
  outcome: AuditOutcome
  tenant_pseudonym: str
  actor_pseudonym: str
  resource_pseudonym: str | None
  previous_hash: str
  integrity_hash: str


class SqliteAuditSink:
  """One-host append-only audit ledger with verified, bounded retention."""

  def __init__(
    self,
    path: str | Path,
    *,
    hmac_key: bytes,
    clock: Callable[[], datetime] | None = None,
  ):
    if not isinstance(hmac_key, bytes) or len(hmac_key) < 32:
      raise ValueError("hmac_key must contain at least 32 bytes")
    self.path = Path(path)
    self._hmac_key = bytes(hmac_key)
    self._clock = clock or (lambda: datetime.now(UTC))
    self._closed = False
    self._initialize()

  def close(self) -> None:
    self._closed = True

  def record(self, event: AuditEvent) -> StoredAuditEvent:
    if self._closed:
      raise AuditWriteError("audit sink is closed")
    if not isinstance(event, AuditEvent):
      raise TypeError("event must be an AuditEvent")
    occurred_at = self._utc_timestamp(self._clock())
    safe_values = self._safe_values(event)
    try:
      with self._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        self._verify_connection(connection)
        existing = connection.execute(
          "SELECT * FROM audit_events WHERE event_id = ?", (event.event_id,)
        ).fetchone()
        if existing is not None:
          stored = self._stored_event(existing)
          if self._event_identity(stored) != self._safe_identity(safe_values):
            raise AuditConflict("event_id is already bound to different audit metadata")
          connection.commit()
          return stored
        base_sequence, base_hash = self._read_anchor(connection)
        latest = connection.execute(
          "SELECT sequence, integrity_hash FROM audit_events ORDER BY sequence DESC LIMIT 1"
        ).fetchone()
        sequence = int(latest["sequence"]) + 1 if latest else base_sequence + 1
        previous_hash = str(latest["integrity_hash"]) if latest else base_hash
        payload = {
          "sequence": sequence,
          "occurred_at": occurred_at,
          **safe_values,
          "previous_hash": previous_hash,
        }
        integrity_hash = self._chain_hash(payload)
        connection.execute(
          """
          INSERT INTO audit_events (
            sequence, occurred_at, service, release_sha, event_id, request_id,
            action, outcome, tenant_pseudonym, actor_pseudonym,
            resource_pseudonym, previous_hash, integrity_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          """,
          (
            sequence,
            occurred_at,
            safe_values["service"],
            safe_values["release_sha"],
            safe_values["event_id"],
            safe_values["request_id"],
            safe_values["action"],
            safe_values["outcome"],
            safe_values["tenant_pseudonym"],
            safe_values["actor_pseudonym"],
            safe_values["resource_pseudonym"],
            previous_hash,
            integrity_hash,
          ),
        )
        connection.execute(
          """
          UPDATE audit_meta SET head_sequence = ?, head_hash = ?, head_hmac = ?
          WHERE singleton = 1
          """,
          (sequence, integrity_hash, self._head_hmac(sequence, integrity_hash)),
        )
        connection.commit()
        row = connection.execute(
          "SELECT * FROM audit_events WHERE sequence = ?", (sequence,)
        ).fetchone()
        if row is None:
          raise AuditWriteError("durable audit append could not be read back")
        return self._stored_event(row)
    except (OSError, sqlite3.Error) as issue:
      raise AuditWriteError("durable audit append failed") from issue

  def query(
    self,
    *,
    limit: int,
    after_sequence: int = 0,
    actions: tuple[AuditAction, ...] | None = None,
  ) -> list[StoredAuditEvent]:
    self._require_open()
    if not 1 <= limit <= MAX_QUERY_LIMIT:
      raise ValueError(f"limit must be between 1 and {MAX_QUERY_LIMIT}")
    if after_sequence < 0:
      raise ValueError("after_sequence must be non-negative")
    if actions is not None and any(not isinstance(action, AuditAction) for action in actions):
      raise ValueError("actions must contain only AuditAction values")
    try:
      with self._connect() as connection:
        self._verify_connection(connection)
        parameters: list[object] = [after_sequence]
        statement = "SELECT * FROM audit_events WHERE sequence > ?"
        if actions is not None:
          if not actions:
            return []
          placeholders = ",".join("?" for _ in actions)
          statement += f" AND action IN ({placeholders})"
          parameters.extend(action.value for action in actions)
        statement += " ORDER BY sequence LIMIT ?"
        parameters.append(limit)
        return [
          self._stored_event(row)
          for row in connection.execute(statement, tuple(parameters)).fetchall()
        ]
    except (OSError, sqlite3.Error) as issue:
      raise AuditError("audit query failed") from issue

  def prune_before(self, cutoff: datetime, *, limit: int) -> int:
    """Remove only a bounded verified prefix and authenticate its new anchor."""
    self._require_open()
    if not 1 <= limit <= MAX_RETENTION_LIMIT:
      raise ValueError(f"limit must be between 1 and {MAX_RETENTION_LIMIT}")
    cutoff_text = self._utc_timestamp(cutoff)
    try:
      with self._connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        self._verify_connection(connection)
        rows = connection.execute(
          """
          SELECT sequence, integrity_hash FROM audit_events
          WHERE occurred_at < ? ORDER BY sequence LIMIT ?
          """,
          (cutoff_text, limit),
        ).fetchall()
        if not rows:
          connection.commit()
          return 0
        last_sequence = int(rows[-1]["sequence"])
        last_hash = str(rows[-1]["integrity_hash"])
        connection.execute(
          """
          UPDATE audit_meta SET base_sequence = ?, base_hash = ?, anchor_hmac = ?
          WHERE singleton = 1
          """,
          (last_sequence, last_hash, self._anchor_hmac(last_sequence, last_hash)),
        )
        connection.execute("DELETE FROM audit_events WHERE sequence <= ?", (last_sequence,))
        connection.commit()
        return len(rows)
    except (OSError, sqlite3.Error) as issue:
      raise AuditWriteError("audit retention failed") from issue

  def verify_integrity(self) -> int:
    self._require_open()
    try:
      with self._connect() as connection:
        return self._verify_connection(connection)
    except (OSError, sqlite3.Error) as issue:
      raise AuditIntegrityError("audit ledger could not be verified") from issue

  def _initialize(self) -> None:
    try:
      self.path.parent.mkdir(parents=True, exist_ok=True)
      descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
      os.close(descriptor)
      self.path.chmod(0o600)
      with sqlite3.connect(self.path, timeout=5, isolation_level=None) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        action_values = ",".join(f"'{item.value}'" for item in AuditAction)
        outcome_values = ",".join(f"'{item.value}'" for item in AuditOutcome)
        connection.execute(
          f"""
          CREATE TABLE IF NOT EXISTS audit_events (
            sequence INTEGER PRIMARY KEY,
            occurred_at TEXT NOT NULL,
            service TEXT NOT NULL,
            release_sha TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            request_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ({action_values})),
            outcome TEXT NOT NULL CHECK(outcome IN ({outcome_values})),
            tenant_pseudonym TEXT NOT NULL,
            actor_pseudonym TEXT NOT NULL,
            resource_pseudonym TEXT,
            previous_hash TEXT NOT NULL,
            integrity_hash TEXT NOT NULL UNIQUE
          )
          """
        )
        connection.execute(
          """
          CREATE TABLE IF NOT EXISTS audit_meta (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            base_sequence INTEGER NOT NULL,
            base_hash TEXT NOT NULL,
            anchor_hmac TEXT NOT NULL,
            head_sequence INTEGER NOT NULL,
            head_hash TEXT NOT NULL,
            head_hmac TEXT NOT NULL
          )
          """
        )
        connection.execute(
          """
          INSERT OR IGNORE INTO audit_meta(
            singleton, base_sequence, base_hash, anchor_hmac,
            head_sequence, head_hash, head_hmac
          ) VALUES (1, 0, ?, ?, 0, ?, ?)
          """,
          (
            GENESIS_HASH,
            self._anchor_hmac(0, GENESIS_HASH),
            GENESIS_HASH,
            self._head_hmac(0, GENESIS_HASH),
          ),
        )
      self.path.chmod(0o600)
    except (OSError, sqlite3.Error) as issue:
      raise AuditWriteError("audit sink initialization failed") from issue

  def _connect(self) -> sqlite3.Connection:
    connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("PRAGMA busy_timeout=5000")
    return connection

  def _verify_connection(self, connection: sqlite3.Connection) -> int:
    base_sequence, base_hash = self._read_anchor(connection)
    head_sequence, head_hash = self._read_head(connection)
    rows = connection.execute("SELECT * FROM audit_events ORDER BY sequence").fetchall()
    expected_sequence = base_sequence + 1
    previous_hash = base_hash
    for position, row in enumerate(rows):
      sequence = int(row["sequence"])
      if sequence != expected_sequence:
        label = "prefix" if position == 0 else f"sequence {sequence}"
        raise AuditIntegrityError(f"audit chain has a missing or changed {label}")
      if str(row["previous_hash"]) != previous_hash:
        raise AuditIntegrityError(f"audit chain predecessor mismatch at sequence {sequence}")
      payload = self._hash_payload(row)
      expected_hash = self._chain_hash(payload)
      if not hmac.compare_digest(str(row["integrity_hash"]), expected_hash):
        raise AuditIntegrityError(f"audit integrity mismatch at sequence {sequence}")
      previous_hash = expected_hash
      expected_sequence += 1
    retained_head_sequence = expected_sequence - 1
    if retained_head_sequence != head_sequence or not hmac.compare_digest(previous_hash, head_hash):
      raise AuditIntegrityError("audit head does not match the retained chain")
    return len(rows)

  def _read_anchor(self, connection: sqlite3.Connection) -> tuple[int, str]:
    row = connection.execute(
      "SELECT base_sequence, base_hash, anchor_hmac FROM audit_meta WHERE singleton = 1"
    ).fetchone()
    if row is None:
      raise AuditIntegrityError("audit retention anchor is missing")
    sequence = int(row["base_sequence"])
    base_hash = str(row["base_hash"])
    expected = self._anchor_hmac(sequence, base_hash)
    if not hmac.compare_digest(str(row["anchor_hmac"]), expected):
      raise AuditIntegrityError("audit retention anchor was changed")
    return sequence, base_hash

  def _read_head(self, connection: sqlite3.Connection) -> tuple[int, str]:
    row = connection.execute(
      "SELECT head_sequence, head_hash, head_hmac FROM audit_meta WHERE singleton = 1"
    ).fetchone()
    if row is None:
      raise AuditIntegrityError("audit head is missing")
    sequence = int(row["head_sequence"])
    head_hash = str(row["head_hash"])
    expected = self._head_hmac(sequence, head_hash)
    if not hmac.compare_digest(str(row["head_hmac"]), expected):
      raise AuditIntegrityError("audit head was changed")
    return sequence, head_hash

  def _safe_values(self, event: AuditEvent) -> dict[str, str | None]:
    return {
      "service": event.service,
      "release_sha": event.release_sha,
      "event_id": event.event_id,
      "request_id": event.request_id,
      "action": event.action.value,
      "outcome": event.outcome.value,
      "tenant_pseudonym": self._pseudonym("tenant", event.tenant_id),
      "actor_pseudonym": self._pseudonym("actor", event.actor_id),
      "resource_pseudonym": (
        self._pseudonym("resource", event.resource_id) if event.resource_id is not None else None
      ),
    }

  @staticmethod
  def _event_identity(stored: StoredAuditEvent) -> tuple:
    return (
      stored.service,
      stored.release_sha,
      stored.event_id,
      stored.request_id,
      stored.action.value,
      stored.outcome.value,
      stored.tenant_pseudonym,
      stored.actor_pseudonym,
      stored.resource_pseudonym,
    )

  @staticmethod
  def _safe_identity(values: dict[str, str | None]) -> tuple:
    return tuple(
      values[name]
      for name in (
        "service",
        "release_sha",
        "event_id",
        "request_id",
        "action",
        "outcome",
        "tenant_pseudonym",
        "actor_pseudonym",
        "resource_pseudonym",
      )
    )

  @staticmethod
  def _stored_event(row: sqlite3.Row) -> StoredAuditEvent:
    try:
      action = AuditAction(str(row["action"]))
      outcome = AuditOutcome(str(row["outcome"]))
    except ValueError as issue:
      raise AuditIntegrityError(f"audit enum changed at sequence {row['sequence']}") from issue
    return StoredAuditEvent(
      sequence=int(row["sequence"]),
      occurred_at=str(row["occurred_at"]),
      service=str(row["service"]),
      release_sha=str(row["release_sha"]),
      event_id=str(row["event_id"]),
      request_id=str(row["request_id"]),
      action=action,
      outcome=outcome,
      tenant_pseudonym=str(row["tenant_pseudonym"]),
      actor_pseudonym=str(row["actor_pseudonym"]),
      resource_pseudonym=(
        str(row["resource_pseudonym"]) if row["resource_pseudonym"] is not None else None
      ),
      previous_hash=str(row["previous_hash"]),
      integrity_hash=str(row["integrity_hash"]),
    )

  @staticmethod
  def _hash_payload(row: sqlite3.Row) -> dict[str, object]:
    return {
      "sequence": int(row["sequence"]),
      "occurred_at": str(row["occurred_at"]),
      "service": str(row["service"]),
      "release_sha": str(row["release_sha"]),
      "event_id": str(row["event_id"]),
      "request_id": str(row["request_id"]),
      "action": str(row["action"]),
      "outcome": str(row["outcome"]),
      "tenant_pseudonym": str(row["tenant_pseudonym"]),
      "actor_pseudonym": str(row["actor_pseudonym"]),
      "resource_pseudonym": (
        str(row["resource_pseudonym"]) if row["resource_pseudonym"] is not None else None
      ),
      "previous_hash": str(row["previous_hash"]),
    }

  def _pseudonym(self, kind: str, value: str) -> str:
    payload = f"audit-pseudonym-v1:{kind}\0{value}".encode("utf-8")
    return hmac.new(self._hmac_key, payload, hashlib.sha256).hexdigest()

  def _chain_hash(self, payload: dict[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hmac.new(self._hmac_key, b"audit-chain-v1\0" + encoded, hashlib.sha256).hexdigest()

  def _anchor_hmac(self, sequence: int, base_hash: str) -> str:
    payload = f"audit-anchor-v1:{sequence}:{base_hash}".encode("ascii")
    return hmac.new(self._hmac_key, payload, hashlib.sha256).hexdigest()

  def _head_hmac(self, sequence: int, head_hash: str) -> str:
    payload = f"audit-head-v1:{sequence}:{head_hash}".encode("ascii")
    return hmac.new(self._hmac_key, payload, hashlib.sha256).hexdigest()

  @staticmethod
  def _utc_timestamp(value: datetime) -> str:
    if not isinstance(value, datetime) or value.tzinfo is None:
      raise ValueError("audit timestamps must be timezone-aware")
    return value.astimezone(UTC).isoformat()

  def _require_open(self) -> None:
    if self._closed:
      raise AuditError("audit sink is closed")
