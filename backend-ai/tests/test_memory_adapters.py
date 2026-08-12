from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.memory.adapters import (
  HmacConsentReceiptVerifier,
  MemoryPersistenceUnavailable,
  MemoryProjectionUnavailable,
  MongoMemoryRepository,
  QdrantMemoryCandidateIndex,
  QdrantMemoryProjection,
)
from app.memory.application import MemoryConflict
from app.memory.models import (
  ConsentReceipt,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  content_checksum,
)


NOW = datetime(2026, 8, 11, 12, 0, tzinfo=timezone.utc)
SCOPE = MemoryScope(tenant_id="tenant-1", user_id="user-1")


def receipt(**updates):
  values = {
    "confirmation_id": "unsigned",
    "actor_user_id": SCOPE.user_id,
    "action": "create",
    "intent_checksum": "a" * 64,
    "policy_version": "consent-v1",
    "confirmed_at": NOW,
    "expires_at": NOW + timedelta(minutes=5),
  }
  values.update(updates)
  return ConsentReceipt(**values)


def record(memory_id="memory-1", *, scope=SCOPE, content="Prefer Polish", **updates):
  values = {
    "memory_id": memory_id,
    "scope": scope,
    "memory_type": "preference",
    "conflict_key": "response-style",
    "content": content,
    "source_event_id": "event-1",
    "provenance": "explicit user confirmation",
    "confidence": 1,
    "salience": 0.8,
    "retention_class": "user-controlled",
    "created_at": NOW,
    "updated_at": NOW,
    "expires_at": NOW + timedelta(days=30),
    "checksum": content_checksum(content),
    "status": MemoryStatus.ACTIVE,
    "consent": receipt(),
  }
  values.update(updates)
  return MemoryRecord(**values)


class Session:
  def __init__(self):
    self.transaction_calls = 0

  def __enter__(self):
    return self

  def __exit__(self, *_args):
    return False

  def with_transaction(self, callback):
    self.transaction_calls += 1
    return callback(self)


def repository():
  records = MagicMock()
  records.replace_one.return_value = SimpleNamespace(matched_count=1)
  records.find_one.return_value = None
  idempotency = MagicMock()
  idempotency.find_one.return_value = None
  session = Session()
  client = MagicMock()
  client.start_session.return_value = session
  return MongoMemoryRepository(records, idempotency, client=client), records, idempotency, session


def test_mongo_save_is_transactional_scope_bound_and_durably_idempotent():
  adapter, records, idempotency, session = repository()
  saved = adapter.save(record(), "create-1")

  assert saved.memory_id == "memory-1"
  assert session.transaction_calls == 1
  selector = records.find_one.call_args.args[0]
  assert selector == {"tenant_id": "tenant-1", "user_id": "user-1", "memory_id": "memory-1"}
  assert records.insert_one.call_args.kwargs["session"] is session
  durable_receipt = idempotency.insert_one.call_args.args[0]
  assert "response" not in durable_receipt
  assert "Prefer Polish" not in repr(durable_receipt)

  idempotency.find_one.return_value = durable_receipt
  stored = saved.model_dump(mode="json")
  stored.update(stored.pop("scope"))
  records.find_one.return_value = stored
  records.reset_mock()
  replay = adapter.save(record(), "create-1")
  assert replay == saved
  records.insert_one.assert_not_called()

  with pytest.raises(MemoryConflict, match="different memory mutation"):
    adapter.save(record(content="Different"), "create-1")


def test_mongo_reads_and_export_never_cross_tenant_or_user_scope():
  adapter, records, _idempotency, _session = repository()
  stored = record().model_dump(mode="json")
  stored.update(stored.pop("scope"))
  records.find_one.return_value = stored
  records.find.return_value = [stored]

  assert adapter.get(SCOPE, "memory-1") == record()
  assert adapter.export(SCOPE) == [record()]
  assert records.find_one.call_args.args[0] == {
    "tenant_id": "tenant-1", "user_id": "user-1", "memory_id": "memory-1"
  }
  assert records.find.call_args.args[0] == {"tenant_id": "tenant-1", "user_id": "user-1"}


def test_mongo_write_fails_closed_without_transaction_support():
  adapter = MongoMemoryRepository(MagicMock(), MagicMock(), client=object())
  with pytest.raises(MemoryPersistenceUnavailable, match="transactional session"):
    adapter.save(record(), "create-1")


def test_mongo_save_rejects_racing_create_instead_of_overwriting_it():
  adapter, records, _idempotency, _session = repository()
  existing = record().model_dump(mode="json")
  existing.update(existing.pop("scope"))
  records.find_one.return_value = existing

  with pytest.raises(MemoryConflict, match="durable lifecycle"):
    adapter.save(record(content="Race winner changed content"), "create-2")
  records.replace_one.assert_not_called()


def test_mongo_save_allows_explicit_forward_lifecycle_transition():
  adapter, records, _idempotency, session = repository()
  current = record()
  stored = current.model_dump(mode="json")
  stored.update(stored.pop("scope"))
  records.find_one.return_value = stored
  revoked = current.model_copy(
    update={
      "status": MemoryStatus.CONSENT_REVOKED,
      "updated_at": NOW + timedelta(seconds=1),
      "consent": receipt(action="revoke"),
    }
  )

  assert adapter.save(revoked, "revoke-1") == revoked
  selector = records.replace_one.call_args.args[0]
  assert selector["status"] == "active"
  assert selector["updated_at"] == stored["updated_at"]
  assert records.replace_one.call_args.kwargs["session"] is session


def test_mongo_supersede_is_one_transaction_with_optimistic_active_precondition():
  adapter, records, idempotency, session = repository()
  records.find_one.return_value = None
  previous = record(
    status=MemoryStatus.SUPERSEDED,
    superseded_by_id="memory-2",
  )
  replacement = record(
    "memory-2",
    content="Prefer concise Polish",
    supersedes_id="memory-1",
  )

  assert adapter.supersede(previous, replacement, "supersede-1") == replacement
  assert session.transaction_calls == 1
  selector = records.replace_one.call_args.args[0]
  assert selector["tenant_id"] == "tenant-1"
  assert selector["user_id"] == "user-1"
  assert selector["status"] == "active"
  assert records.insert_one.call_args.args[0]["memory_id"] == "memory-2"
  assert idempotency.insert_one.call_args.kwargs["session"] is session


def test_mongo_supersede_rejects_cross_scope_before_opening_transaction():
  adapter, _records, _idempotency, session = repository()
  previous = record(status=MemoryStatus.SUPERSEDED, superseded_by_id="memory-2")
  replacement = record(
    "memory-2",
    scope=MemoryScope(tenant_id="tenant-2", user_id="user-1"),
    supersedes_id="memory-1",
  )
  with pytest.raises(MemoryConflict, match="cannot cross"):
    adapter.supersede(previous, replacement, "supersede-1")
  assert session.transaction_calls == 0


class Embedding:
  def embed(self, texts):
    assert texts == ["preference"]
    return [[0.1, 0.2, 0.3]]


def test_qdrant_search_has_tenant_and_user_filters_and_rejects_leaked_hits():
  client = MagicMock()
  client.query_points.return_value = SimpleNamespace(points=[
    SimpleNamespace(
      score=0.9,
      payload={
        "tenant_id": "tenant-1", "user_id": "user-1", "memory_id": "memory-1",
        "memory_type": "preference", "checksum": "a" * 64,
        "projection_version": "memory-v1", "status": "active",
        "expires_at": (NOW + timedelta(days=30)).isoformat(),
      },
    ),
    SimpleNamespace(
      score=1,
      payload={
        "tenant_id": "tenant-2", "user_id": "user-1", "memory_id": "leaked",
        "memory_type": "preference", "checksum": "b" * 64,
        "projection_version": "memory-v1", "status": "active",
        "expires_at": (NOW + timedelta(days=30)).isoformat(),
      },
    ),
  ])
  index = QdrantMemoryCandidateIndex(
    client,
    Embedding(),
    collection_name="memory-v1",
    clock=SimpleNamespace(now=lambda: NOW),
  )

  candidates = index.search_ids(SCOPE, "preference", 5)
  assert [candidate.memory_id for candidate in candidates] == ["memory-1"]
  query_filter = client.query_points.call_args.kwargs["query_filter"]
  assert "tenant-1" in repr(query_filter)
  assert "user-1" in repr(query_filter)
  assert "active" in repr(query_filter)
  assert "expires_at" in repr(query_filter)


def test_qdrant_projection_physically_deletes_scope_before_upsert_and_on_erasure():
  client = MagicMock()
  projection = QdrantMemoryProjection(
    client,
    collection_name="memory-v1",
    projection_version="projection-v1",
  )
  active = record()

  projection.project(active, [0.1, 0.2, 0.3])
  assert client.method_calls[0][0] == "delete"
  assert client.method_calls[1][0] == "upsert"
  point = client.upsert.call_args.kwargs["points"][0]
  assert point.payload == {
    "tenant_id": "tenant-1",
    "user_id": "user-1",
    "memory_id": "memory-1",
    "memory_type": "preference",
    "checksum": active.checksum,
    "projection_version": "projection-v1",
    "expires_at": active.expires_at.isoformat(),
    "status": "active",
  }
  selector = client.delete.call_args.kwargs["points_selector"]
  assert "tenant-1" in repr(selector)
  assert "user-1" in repr(selector)
  assert "memory-1" in repr(selector)

  projection.delete(SCOPE, "memory-1")
  assert client.delete.call_count == 2


def test_qdrant_projection_failure_is_explicit_and_canonical_record_is_untouched():
  client = MagicMock()
  client.delete.side_effect = RuntimeError("offline")
  projection = QdrantMemoryProjection(client, collection_name="memory-v1", projection_version="v1")
  with pytest.raises(MemoryProjectionUnavailable, match="delete failed"):
    projection.project(record(), [0.1])
  client.upsert.assert_not_called()


def test_qdrant_projection_inventory_is_paginated_and_defensively_scope_checked():
  client = MagicMock()
  client.scroll.side_effect = [
    ([
      SimpleNamespace(payload={
        "tenant_id": "tenant-1", "user_id": "user-1", "memory_id": "memory-1"
      }),
      SimpleNamespace(payload={
        "tenant_id": "tenant-2", "user_id": "user-1", "memory_id": "leaked"
      }),
    ], "next"),
    ([SimpleNamespace(payload={
      "tenant_id": "tenant-1", "user_id": "user-1", "memory_id": "memory-2"
    })], None),
  ]
  projection = QdrantMemoryProjection(client, collection_name="memory-v1", projection_version="v1")

  assert projection.projected_ids(SCOPE) == {"memory-1", "memory-2"}
  assert client.scroll.call_count == 2
  assert client.scroll.call_args.kwargs["offset"] == "next"


def test_hmac_consent_verifier_binds_every_security_relevant_receipt_field():
  verifier = HmacConsentReceiptVerifier({"active": b"x" * 32})
  signed = verifier.sign(receipt(), key_id="active")
  assert verifier.verify(signed)

  for changed in (
    {"actor_user_id": "user-2"},
    {"action": "delete"},
    {"intent_checksum": "b" * 64},
    {"policy_version": "consent-v2"},
    {"expires_at": NOW + timedelta(minutes=6)},
  ):
    assert not verifier.verify(signed.model_copy(update=changed))
  assert not HmacConsentReceiptVerifier({"rotated": b"y" * 32}).verify(signed)


def test_hmac_verifier_rejects_short_secrets_and_malformed_confirmation_ids():
  with pytest.raises(ValueError, match="at least 32 bytes"):
    HmacConsentReceiptVerifier({"weak": b"short"})
  verifier = HmacConsentReceiptVerifier({"active": b"x" * 32})
  assert not verifier.verify(receipt(confirmation_id="not-signed"))
