from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
from hmac import compare_digest, new as hmac_new
import json
import re
from typing import Callable
from uuid import NAMESPACE_URL, uuid5

from qdrant_client import models as qmodels

from .application import MemoryConflict
from .models import (
  ConsentReceipt,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  ProjectionCandidate,
)


class MemoryPersistenceUnavailable(RuntimeError):
  """Raised when MongoDB cannot provide the required atomic guarantees."""


class MemoryProjectionUnavailable(RuntimeError):
  """Raised when the disposable candidate projection cannot be updated."""


def _record_payload(record: MemoryRecord) -> dict:
  return record.model_dump(mode="json")


def _fingerprint(payload: object) -> str:
  serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
  return sha256(serialized.encode("utf-8")).hexdigest()


class MongoMemoryRepository:
  """Tenant/user-scoped canonical memory persistence.

  Every mutation couples its immutable idempotency receipt and canonical record
  in one MongoDB transaction. A standalone MongoDB therefore fails closed; a
  replica set or sharded cluster is required for writes.
  """

  def __init__(self, records, idempotency, *, client=None):
    self.records = records
    self.idempotency = idempotency
    self.client = client or getattr(getattr(records, "database", None), "client", None)
    self.records.create_index(
      [("tenant_id", 1), ("user_id", 1), ("memory_id", 1)],
      unique=True,
      name="memory_scope_unique",
    )
    self.records.create_index(
      [("tenant_id", 1), ("user_id", 1), ("created_at", 1), ("memory_id", 1)],
      name="memory_scope_list",
    )
    self.records.create_index(
      [("tenant_id", 1), ("user_id", 1), ("conflict_key", 1)],
      unique=True,
      partialFilterExpression={"status": MemoryStatus.ACTIVE.value},
      name="memory_active_conflict_unique",
    )
    self.records.create_index(
      [("expires_at", 1)],
      expireAfterSeconds=0,
      name="memory_expiration_ttl",
    )
    self.idempotency.create_index(
      [("idempotency_key", 1)],
      unique=True,
      name="memory_idempotency_unique",
    )

  def save(self, record: MemoryRecord, idempotency_key: str) -> MemoryRecord:
    payload = _record_payload(record)
    fingerprint = _fingerprint(payload)

    def mutation(session):
      replay = self._idempotency_result(idempotency_key, fingerprint, session=session)
      if replay is not None:
        return replay
      self.idempotency.insert_one(
        self._idempotency_document(idempotency_key, fingerprint, record.scope, record.memory_id),
        session=session,
      )
      self._write_record(record, payload, session=session)
      return record

    try:
      return self._run_transaction(mutation)
    except MemoryConflict:
      replay = self._idempotency_result(idempotency_key, fingerprint, session=None)
      if replay is not None:
        return replay
      raise

  def supersede(
    self,
    previous: MemoryRecord,
    replacement: MemoryRecord,
    idempotency_key: str,
  ) -> MemoryRecord:
    """Atomically supersede one active record and create its replacement."""
    self._validate_supersede(previous, replacement)
    previous_payload = _record_payload(previous)
    replacement_payload = _record_payload(replacement)
    operation_payload = {"previous": previous_payload, "replacement": replacement_payload}
    fingerprint = _fingerprint(operation_payload)

    def mutation(session):
      replay = self._idempotency_result(idempotency_key, fingerprint, session=session)
      if replay is not None:
        return replay
      self.idempotency.insert_one(
        self._idempotency_document(
          idempotency_key,
          fingerprint,
          replacement.scope,
          replacement.memory_id,
        ),
        session=session,
      )
      if self.records.find_one(
        self._scope_selector(replacement.scope, replacement.memory_id),
        session=session,
      ) is not None:
        raise MemoryConflict("replacement memory already exists")
      result = self.records.replace_one(
        {
          **self._scope_selector(previous.scope, previous.memory_id),
          "status": MemoryStatus.ACTIVE.value,
          "checksum": previous.checksum,
        },
        self._stored_record(previous_payload),
        upsert=False,
        session=session,
      )
      if getattr(result, "matched_count", 0) != 1:
        raise MemoryConflict("memory supersede lost its active-record precondition")
      self.records.insert_one(self._stored_record(replacement_payload), session=session)
      return replacement

    try:
      return self._run_transaction(mutation)
    except MemoryConflict:
      replay = self._idempotency_result(idempotency_key, fingerprint, session=None)
      if replay is not None:
        return replay
      raise

  def get(self, scope: MemoryScope, memory_id: str) -> MemoryRecord | None:
    document = self.records.find_one(self._scope_selector(scope, memory_id))
    return self._memory_record(document) if document is not None else None

  def list(self, scope: MemoryScope) -> list[MemoryRecord]:
    documents = self.records.find(
      {"tenant_id": scope.tenant_id, "user_id": scope.user_id},
      sort=[("created_at", 1), ("memory_id", 1)],
    )
    return [self._memory_record(document) for document in documents]

  def export(self, scope: MemoryScope) -> list[MemoryRecord]:
    return self.list(scope)

  def _run_transaction(self, callback: Callable):
    if self.client is None or not callable(getattr(self.client, "start_session", None)):
      raise MemoryPersistenceUnavailable("MongoDB transactional session is required")
    try:
      with self.client.start_session() as session:
        transaction = getattr(session, "with_transaction", None)
        if not callable(transaction):
          raise MemoryPersistenceUnavailable("MongoDB transaction support is required")
        return transaction(callback)
    except (MemoryConflict, MemoryPersistenceUnavailable):
      raise
    except Exception as error:
      if getattr(error, "code", None) == 11000:
        raise MemoryConflict("idempotency key or scoped memory already exists") from error
      raise MemoryPersistenceUnavailable("MongoDB memory transaction failed") from error

  def _idempotency_result(self, key: str, fingerprint: str, *, session) -> MemoryRecord | None:
    prior = self.idempotency.find_one({"idempotency_key": key}, session=session)
    if prior is None:
      return None
    if not compare_digest(str(prior.get("fingerprint", "")), fingerprint):
      raise MemoryConflict("idempotency key reused for a different memory mutation")
    result_ref = prior.get("result_ref")
    if not isinstance(result_ref, dict):
      raise MemoryPersistenceUnavailable("idempotency receipt has no durable result reference")
    required = {"tenant_id", "user_id", "memory_id"}
    if set(result_ref) != required or not all(isinstance(result_ref[key], str) for key in required):
      raise MemoryPersistenceUnavailable("idempotency result reference is malformed")
    document = self.records.find_one(result_ref, session=session)
    if document is None:
      raise MemoryPersistenceUnavailable("idempotency result is missing from canonical storage")
    return self._memory_record(document)

  def _write_record(self, record: MemoryRecord, payload: dict, *, session) -> None:
    selector = self._scope_selector(record.scope, record.memory_id)
    current_document = self.records.find_one(selector, session=session)
    if current_document is None:
      self.records.insert_one(self._stored_record(payload), session=session)
      return
    current = self._memory_record(current_document)
    allowed = {
      MemoryStatus.ACTIVE: {
        MemoryStatus.SUPERSEDED,
        MemoryStatus.CONSENT_REVOKED,
        MemoryStatus.DELETED,
      },
      MemoryStatus.SUPERSEDED: {MemoryStatus.DELETED},
      MemoryStatus.CONSENT_REVOKED: {MemoryStatus.DELETED},
      MemoryStatus.DELETED: set(),
    }
    if record.status not in allowed[current.status] or record.updated_at < current.updated_at:
      raise MemoryConflict("memory mutation violates the durable lifecycle")
    result = self.records.replace_one(
      {
        **selector,
        "status": current.status.value,
        "checksum": current.checksum,
        "updated_at": current_document["updated_at"],
      },
      self._stored_record(payload),
      upsert=False,
      session=session,
    )
    if getattr(result, "matched_count", 0) != 1:
      raise MemoryConflict("memory mutation lost its optimistic concurrency precondition")

  @staticmethod
  def _idempotency_document(
    key: str,
    fingerprint: str,
    scope: MemoryScope,
    memory_id: str,
  ) -> dict:
    if not key:
      raise ValueError("idempotency key is required")
    return {
      "idempotency_key": key,
      "fingerprint": fingerprint,
      "result_ref": {
        "tenant_id": scope.tenant_id,
        "user_id": scope.user_id,
        "memory_id": memory_id,
      },
    }

  @staticmethod
  def _scope_selector(scope: MemoryScope, memory_id: str) -> dict:
    return {
      "tenant_id": scope.tenant_id,
      "user_id": scope.user_id,
      "memory_id": memory_id,
    }

  @staticmethod
  def _stored_record(payload: dict) -> dict:
    stored = dict(payload)
    scope = stored.pop("scope")
    stored["tenant_id"] = scope["tenant_id"]
    stored["user_id"] = scope["user_id"]
    for field in ("created_at", "updated_at", "expires_at"):
      value = stored.get(field)
      if isinstance(value, str):
        stored[field] = datetime.fromisoformat(value)
    return stored

  @staticmethod
  def _memory_record(document: dict) -> MemoryRecord:
    payload = {key: value for key, value in document.items() if key != "_id"}
    payload["scope"] = {
      "tenant_id": payload.pop("tenant_id"),
      "user_id": payload.pop("user_id"),
    }
    return MemoryRecord.model_validate(payload)

  @staticmethod
  def _validate_supersede(previous: MemoryRecord, replacement: MemoryRecord) -> None:
    if previous.scope != replacement.scope:
      raise MemoryConflict("supersede cannot cross tenant or user scope")
    if previous.status is not MemoryStatus.SUPERSEDED:
      raise MemoryConflict("previous memory must be marked superseded")
    if replacement.status is not MemoryStatus.ACTIVE:
      raise MemoryConflict("replacement memory must be active")
    if previous.superseded_by_id != replacement.memory_id:
      raise MemoryConflict("previous memory does not reference replacement")
    if replacement.supersedes_id != previous.memory_id:
      raise MemoryConflict("replacement memory does not reference previous")


class QdrantMemoryCandidateIndex:
  """Searches only opaque candidate IDs; Mongo remains authoritative."""

  def __init__(self, client, embedding_provider, *, collection_name: str, clock=None):
    self.client = client
    self.embedding_provider = embedding_provider
    self.collection_name = collection_name
    self.clock = clock

  def search_ids(self, scope: MemoryScope, text: str, limit: int) -> list[ProjectionCandidate]:
    vector = self.embedding_provider.embed([text])[0]
    now = self.clock.now() if self.clock is not None else datetime.now(timezone.utc)
    result = self.client.query_points(
      collection_name=self.collection_name,
      query=vector,
      query_filter=_active_scope_filter(scope, now),
      limit=limit,
      with_payload=True,
      with_vectors=False,
    )
    candidates = []
    for point in result.points:
      payload = dict(point.payload or {})
      try:
        expires_at = datetime.fromisoformat(str(payload["expires_at"]))
      except (KeyError, TypeError, ValueError):
        continue
      if (
        payload.get("tenant_id") != scope.tenant_id
        or payload.get("user_id") != scope.user_id
        or payload.get("status") != MemoryStatus.ACTIVE.value
        or expires_at <= now
      ):
        continue
      try:
        candidates.append(
          ProjectionCandidate(
            memory_id=str(payload["memory_id"]),
            score=float(point.score),
            projection_version=str(payload["projection_version"]),
            checksum=str(payload["checksum"]),
          )
        )
      except (KeyError, TypeError, ValueError):
        continue
    return candidates


class QdrantMemoryProjection:
  """Disposable vector projection with scope-bound upsert and physical delete."""

  def __init__(self, client, *, collection_name: str, projection_version: str):
    self.client = client
    self.collection_name = collection_name
    self.projection_version = projection_version

  def project(self, record: MemoryRecord, vector: list[float]) -> None:
    if record.status is not MemoryStatus.ACTIVE:
      raise ValueError("only active memories may be projected")
    self.delete(record.scope, record.memory_id)
    point = qmodels.PointStruct(
      id=str(uuid5(NAMESPACE_URL, self._point_key(record.scope, record.memory_id))),
      vector=vector,
      payload={
        "tenant_id": record.scope.tenant_id,
        "user_id": record.scope.user_id,
        "memory_id": record.memory_id,
        "memory_type": record.memory_type,
        "checksum": record.checksum,
        "projection_version": self.projection_version,
        "expires_at": record.expires_at.isoformat(),
        "status": record.status.value,
      },
    )
    try:
      self.client.upsert(collection_name=self.collection_name, points=[point], wait=True)
    except Exception as error:
      raise MemoryProjectionUnavailable("Qdrant memory upsert failed") from error

  def delete(self, scope: MemoryScope, memory_id: str) -> None:
    selector = qmodels.FilterSelector(
      filter=qmodels.Filter(
        must=[
          *_scope_filter(scope).must,
          qmodels.FieldCondition(key="memory_id", match=qmodels.MatchValue(value=memory_id)),
        ]
      )
    )
    try:
      self.client.delete(
        collection_name=self.collection_name,
        points_selector=selector,
        wait=True,
      )
    except Exception as error:
      raise MemoryProjectionUnavailable("Qdrant memory delete failed") from error

  def projected_ids(self, scope: MemoryScope) -> set[str]:
    projected = set()
    offset = None
    try:
      while True:
        points, next_offset = self.client.scroll(
          collection_name=self.collection_name,
          scroll_filter=_scope_filter(scope),
          limit=1_000,
          offset=offset,
          with_payload=True,
          with_vectors=False,
        )
        projected.update(
          str(point.payload["memory_id"])
          for point in points
          if point.payload
          and point.payload.get("tenant_id") == scope.tenant_id
          and point.payload.get("user_id") == scope.user_id
          and point.payload.get("memory_id")
        )
        if next_offset is None:
          return projected
        offset = next_offset
    except Exception as error:
      raise MemoryProjectionUnavailable("Qdrant memory inventory failed") from error

  @staticmethod
  def _point_key(scope: MemoryScope, memory_id: str) -> str:
    return f"memory:{scope.tenant_id}:{scope.user_id}:{memory_id}"


def _scope_filter(scope: MemoryScope) -> qmodels.Filter:
  return qmodels.Filter(
    must=[
      qmodels.FieldCondition(key="tenant_id", match=qmodels.MatchValue(value=scope.tenant_id)),
      qmodels.FieldCondition(key="user_id", match=qmodels.MatchValue(value=scope.user_id)),
    ]
  )


def _active_scope_filter(scope: MemoryScope, now: datetime) -> qmodels.Filter:
  return qmodels.Filter(
    must=[
      *_scope_filter(scope).must,
      qmodels.FieldCondition(
        key="status",
        match=qmodels.MatchValue(value=MemoryStatus.ACTIVE.value),
      ),
      qmodels.FieldCondition(
        key="expires_at",
        range=qmodels.DatetimeRange(gt=now),
      ),
    ]
  )


class HmacConsentReceiptVerifier:
  """Verifies a consent receipt signed by a trusted confirmation boundary."""

  _CONFIRMATION_PATTERN = re.compile(r"^h1:([A-Za-z0-9_-]{1,32}):([a-f0-9]{64})$")

  def __init__(self, keys: dict[str, bytes]):
    invalid_key = any(not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", key_id) for key_id in keys)
    invalid_secret = any(not isinstance(secret, bytes) or len(secret) < 32 for secret in keys.values())
    if not keys or invalid_key or invalid_secret:
      raise ValueError("every HMAC consent key must contain at least 32 bytes")
    self.keys = dict(keys)

  def verify(self, receipt: ConsentReceipt) -> bool:
    match = self._CONFIRMATION_PATTERN.fullmatch(receipt.confirmation_id)
    if match is None:
      return False
    key_id, supplied = match.groups()
    secret = self.keys.get(key_id)
    if secret is None:
      return False
    expected = hmac_new(secret, self._payload(receipt), "sha256").hexdigest()
    return compare_digest(supplied, expected)

  def sign(self, receipt: ConsentReceipt, *, key_id: str) -> ConsentReceipt:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", key_id):
      raise ValueError("invalid consent key id")
    secret = self.keys.get(key_id)
    if secret is None:
      raise ValueError("unknown consent key id")
    signature = hmac_new(secret, self._payload(receipt), "sha256").hexdigest()
    return receipt.model_copy(update={"confirmation_id": f"h1:{key_id}:{signature}"})

  @staticmethod
  def _payload(receipt: ConsentReceipt) -> bytes:
    payload = {
      "actor_user_id": receipt.actor_user_id,
      "action": receipt.action,
      "intent_checksum": receipt.intent_checksum,
      "policy_version": receipt.policy_version,
      "confirmed_at": receipt.confirmed_at.isoformat(),
      "expires_at": receipt.expires_at.isoformat(),
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
