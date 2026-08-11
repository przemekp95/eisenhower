from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.memory.models import ConsentReceipt, MemoryRecord, MemoryScope, MemoryStatus, content_checksum


NOW = datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)
SCOPE = MemoryScope(tenant_id="tenant-1", user_id="user-1")


def receipt(**overrides):
  values = {
    "confirmation_id": "confirm-1",
    "actor_user_id": "user-1",
    "action": "create",
    "intent_checksum": "a" * 64,
    "policy_version": "consent-v1",
    "confirmed_at": NOW,
    "expires_at": NOW + timedelta(minutes=5),
  }
  values.update(overrides)
  return ConsentReceipt(**values)


def test_consent_receipt_requires_utc_and_future_expiry():
  with pytest.raises(ValidationError):
    receipt(confirmed_at=datetime(2026, 8, 10, 12, 0))
  with pytest.raises(ValidationError):
    receipt(expires_at=NOW)


def test_memory_record_validates_checksum_and_lifecycle_dates():
  record = MemoryRecord(
    memory_id="memory-1",
    scope=SCOPE,
    memory_type="preference",
    conflict_key="response-style",
    content="Prefer Polish responses",
    source_event_id="event-1",
    provenance="explicit user confirmation",
    confidence=1,
    salience=0.8,
    retention_class="user-controlled",
    created_at=NOW,
    updated_at=NOW,
    expires_at=NOW + timedelta(days=30),
    checksum=content_checksum("Prefer Polish responses"),
    status=MemoryStatus.ACTIVE,
    consent=receipt(),
  )
  assert record.status is MemoryStatus.ACTIVE

  with pytest.raises(ValidationError):
    record.model_copy(update={"checksum": "0" * 64}).model_validate(
      record.model_copy(update={"checksum": "0" * 64}).model_dump()
    )
