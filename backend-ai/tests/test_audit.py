from __future__ import annotations

from datetime import UTC, datetime, timedelta
import sqlite3
import stat

import pytest

from app.audit import (
  AuditAction,
  AuditConflict,
  AuditEvent,
  AuditIntegrityError,
  AuditOutcome,
  AuditWriteError,
  SqliteAuditSink,
)


KEY = b"audit-test-key-with-at-least-32-bytes"
RELEASE_SHA = "a" * 40


def event(
  event_id: str,
  *,
  action: AuditAction = AuditAction.ADMIN_OPERATION,
  outcome: AuditOutcome = AuditOutcome.SUCCESS,
  request_id: str = "request-1",
) -> AuditEvent:
  return AuditEvent(
    service="backend-ai",
    release_sha=RELEASE_SHA,
    event_id=event_id,
    request_id=request_id,
    action=action,
    outcome=outcome,
    tenant_id="private-tenant",
    actor_id="private-user@example.test",
    resource_id="private-document-123",
  )


def test_persists_only_pseudonymous_bounded_events_across_restart(tmp_path):
  path = tmp_path / "audit.sqlite3"
  sink = SqliteAuditSink(path, hmac_key=KEY)

  stored = sink.record(event("event-1"))
  sink.close()
  reopened = SqliteAuditSink(path, hmac_key=KEY)

  records = reopened.query(limit=10)
  assert records == [stored]
  assert stored.sequence == 1
  assert datetime.fromisoformat(stored.occurred_at).tzinfo is UTC
  assert stored.tenant_pseudonym != "private-tenant"
  assert stored.actor_pseudonym != "private-user@example.test"
  assert stored.resource_pseudonym != "private-document-123"
  assert len(stored.tenant_pseudonym) == 64
  assert reopened.verify_integrity() == 1
  assert stat.S_IMODE(path.stat().st_mode) == 0o600
  with sqlite3.connect(path) as connection:
    assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    columns = {row[1] for row in connection.execute("PRAGMA table_info(audit_events)")}
  assert not columns & {"content", "body", "token", "prompt", "args", "tenant_id", "actor_id", "resource_id"}
  database_bytes = path.read_bytes()
  for private_value in (b"private-tenant", b"private-user@example.test", b"private-document-123"):
    assert private_value not in database_bytes


def test_schema_rejects_open_values_sensitive_fields_and_invalid_identifiers(tmp_path):
  with pytest.raises(ValueError, match="AuditAction"):
    event("event-open").model_copy(action="admin_operation")
  with pytest.raises(TypeError):
    AuditEvent(  # pylint: disable=unexpected-keyword-arg
      service="backend-ai",
      release_sha=RELEASE_SHA,
      event_id="event-sensitive",
      request_id="request-1",
      action=AuditAction.ADMIN_OPERATION,
      outcome=AuditOutcome.SUCCESS,
      tenant_id="tenant",
      actor_id="actor",
      resource_id="resource",
      content="must never be accepted",
    )
  with pytest.raises(ValueError, match="release_sha"):
    event("event-bad-sha").model_copy(release_sha="latest")
  with pytest.raises(ValueError, match="event_id"):
    event("contains whitespace")
  with pytest.raises(ValueError, match="hmac_key"):
    SqliteAuditSink(tmp_path / "weak.sqlite3", hmac_key=b"short")


def test_event_id_is_idempotent_but_conflicting_reuse_fails_closed(tmp_path):
  sink = SqliteAuditSink(tmp_path / "audit.sqlite3", hmac_key=KEY)
  first = sink.record(event("event-1"))

  assert sink.record(event("event-1")) == first
  with pytest.raises(AuditConflict, match="event_id"):
    sink.record(event("event-1", outcome=AuditOutcome.REJECTED))
  assert sink.verify_integrity() == 1


def test_attempt_is_a_closed_outcome_for_fail_closed_preflight(tmp_path):
  sink = SqliteAuditSink(tmp_path / "audit.sqlite3", hmac_key=KEY)

  stored = sink.record(event("event-attempt", outcome=AuditOutcome.ATTEMPT))

  assert stored.outcome is AuditOutcome.ATTEMPT


def test_integrity_chain_detects_external_update_or_prefix_deletion(tmp_path):
  path = tmp_path / "audit.sqlite3"
  sink = SqliteAuditSink(path, hmac_key=KEY)
  sink.record(event("event-1"))
  sink.record(event("event-2"))

  with sqlite3.connect(path) as connection:
    connection.execute("UPDATE audit_events SET outcome = 'error' WHERE sequence = 1")
  with pytest.raises(AuditIntegrityError, match="sequence 1"):
    sink.verify_integrity()

  clean_path = tmp_path / "audit-prefix.sqlite3"
  clean = SqliteAuditSink(clean_path, hmac_key=KEY)
  clean.record(event("event-a"))
  clean.record(event("event-b"))
  with sqlite3.connect(clean_path) as connection:
    connection.execute("DELETE FROM audit_events WHERE sequence = 1")
  with pytest.raises(AuditIntegrityError, match="prefix"):
    clean.verify_integrity()

  tail_path = tmp_path / "audit-tail.sqlite3"
  tail = SqliteAuditSink(tail_path, hmac_key=KEY)
  tail.record(event("event-tail-a"))
  tail.record(event("event-tail-b"))
  with sqlite3.connect(tail_path) as connection:
    connection.execute("DELETE FROM audit_events WHERE sequence = 2")
  with pytest.raises(AuditIntegrityError, match="head"):
    tail.verify_integrity()


def test_query_and_retention_are_bounded_and_preserve_a_verified_anchor(tmp_path):
  start = datetime(2026, 8, 12, 8, tzinfo=UTC)
  moments = iter([start, start + timedelta(hours=1), start + timedelta(hours=2)])
  sink = SqliteAuditSink(tmp_path / "audit.sqlite3", hmac_key=KEY, clock=lambda: next(moments))
  sink.record(event("event-1", action=AuditAction.INGEST))
  sink.record(event("event-2", action=AuditAction.REINDEX))
  third = sink.record(event("event-3", action=AuditAction.MCP_TOOL_USE))

  assert sink.query(limit=1) == [sink.query(limit=3)[0]]
  assert sink.query(limit=10, after_sequence=2) == [third]
  assert sink.query(limit=10, actions=(AuditAction.MCP_TOOL_USE,)) == [third]
  with pytest.raises(ValueError, match="limit"):
    sink.query(limit=501)
  with pytest.raises(ValueError, match="limit"):
    sink.prune_before(start + timedelta(hours=2), limit=1001)

  assert sink.prune_before(start + timedelta(hours=2), limit=1) == 1
  assert [item.sequence for item in sink.query(limit=10)] == [2, 3]
  assert sink.verify_integrity() == 2
  assert sink.prune_before(start + timedelta(hours=2), limit=10) == 1
  assert sink.query(limit=10) == [third]
  assert sink.verify_integrity() == 1


def test_closed_sink_surfaces_write_failure_instead_of_dropping_audit(tmp_path):
  sink = SqliteAuditSink(tmp_path / "audit.sqlite3", hmac_key=KEY)
  sink.close()

  with pytest.raises(AuditWriteError, match="closed"):
    sink.record(event("event-1"))
