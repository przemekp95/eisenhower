from datetime import datetime, timedelta, timezone

from app.memory.models import (
  ConsentReceipt,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  content_checksum,
)
from app.memory.reconciliation import MemoryProjectionReconciler


NOW = datetime(2026, 8, 11, 12, 0, tzinfo=timezone.utc)
SCOPE = MemoryScope(tenant_id="tenant-1", user_id="user-1")


class Clock:
  @staticmethod
  def now():
    return NOW


class Repository:
  def __init__(self, records):
    self.records = records

  def list(self, scope):
    assert scope == SCOPE
    return self.records


class Projection:
  def __init__(self, projected):
    self.projected = set(projected)
    self.project_calls = []
    self.delete_calls = []

  def projected_ids(self, scope):
    assert scope == SCOPE
    return set(self.projected)

  def project(self, record, vector):
    self.project_calls.append((record.memory_id, vector))

  def delete(self, scope, memory_id):
    self.delete_calls.append((scope, memory_id))


class Embedding:
  @staticmethod
  def embed(texts):
    return [[float(len(texts[0]))]]


def record(memory_id, *, status=MemoryStatus.ACTIVE, expires_at=None):
  content = f"memory {memory_id}"
  return MemoryRecord(
    memory_id=memory_id,
    scope=SCOPE,
    memory_type="communication_preference",
    conflict_key=f"subject-{memory_id}",
    content=content,
    source_event_id=f"event-{memory_id}",
    provenance="explicit confirmation",
    confidence=1,
    salience=0.5,
    retention_class="user_controlled",
    created_at=NOW - timedelta(days=1),
    updated_at=NOW - timedelta(days=1),
    expires_at=expires_at or NOW + timedelta(days=1),
    checksum=content_checksum(content),
    status=status,
    consent=ConsentReceipt(
      confirmation_id=f"confirmation-{memory_id}",
      actor_user_id=SCOPE.user_id,
      action="create",
      intent_checksum="a" * 64,
      policy_version="memory-v1",
      confirmed_at=NOW - timedelta(days=1),
      expires_at=NOW + timedelta(days=1),
    ),
  )


def test_reconciliation_rebuilds_active_deletes_inactive_expired_and_orphan_projection():
  records = [
    record("active"),
    record("revoked", status=MemoryStatus.CONSENT_REVOKED),
    record("expired", expires_at=NOW - timedelta(seconds=1)),
  ]
  projection = Projection({"active", "revoked", "expired", "orphan"})
  reconciler = MemoryProjectionReconciler(
    Repository(records),
    projection,
    Embedding(),
    Clock(),
  )

  assert reconciler.reconcile(SCOPE) == {
    "projected": 1,
    "deleted": 2,
    "orphans_deleted": 1,
  }
  assert projection.project_calls == [("active", [13.0])]
  assert {memory_id for _scope, memory_id in projection.delete_calls} == {
    "revoked", "expired", "orphan"
  }
