import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from app.memory.adapters import (
  HmacConsentReceiptVerifier,
  MongoMemoryRepository,
  QdrantMemoryCandidateIndex,
  QdrantMemoryProjection,
)
from app.memory.application import MemoryApplication, MemoryConflict
from app.memory.commands import CreateConfirmedMemory, DeleteMemory, RevokeConsent, SupersedeMemory
from app.memory.models import (
  ConsentReceipt,
  MemoryScope,
  MemoryStatus,
  content_checksum,
  intent_checksum,
)
from app.memory.policy import MemoryPolicy
from app.memory.reconciliation import MemoryProjectionReconciler


pytestmark = pytest.mark.skipif(
  os.getenv("RUN_LIVE_MEMORY_TESTS") != "1",
  reason="requires explicitly enabled isolated Mongo replica set and local Qdrant",
)


class Clock:
  def __init__(self, now):
    self.value = now

  def now(self):
    return self.value


class ConstantEmbedding:
  @staticmethod
  def embed(texts):
    return [[1.0, float(len(text) % 7), 0.5] for text in texts]


def test_confirmed_memory_lifecycle_uses_transactional_mongo_and_separate_qdrant_projection():
  from pymongo import MongoClient
  from qdrant_client import QdrantClient, models as qmodels

  suffix = uuid4().hex
  database_name = f"eisenhower_task019_verify_{suffix}"
  collection_name = f"task019_memory_{suffix}"
  mongo = MongoClient(
    "mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true",
    serverSelectionTimeoutMS=5_000,
  )
  qdrant = QdrantClient(url="http://127.0.0.1:6333", timeout=10)
  now = datetime.now(timezone.utc).replace(microsecond=0)
  clock = Clock(now)
  scope = MemoryScope(tenant_id="tenant-runtime", user_id="user-runtime")
  secret = b"task019-local-runtime-proof-key-32-bytes-minimum"
  verifier = HmacConsentReceiptVerifier({"runtime": secret})
  policy = MemoryPolicy.load(
    Path(__file__).resolve().parents[2] / "docs" / "ai-rebuild" / "memory-policy-v1.json"
  )

  def receipt(action, memory_id, content, **bound_fields):
    unsigned = ConsentReceipt(
      confirmation_id="unsigned",
      actor_user_id=scope.user_id,
      action=action,
      intent_checksum=intent_checksum(
        action,
        scope,
        memory_id,
        content,
        **bound_fields,
      ),
      policy_version=policy.policy_version,
      confirmed_at=now,
      expires_at=now + timedelta(minutes=5),
    )
    return verifier.sign(unsigned, key_id="runtime")

  try:
    assert mongo.admin.command("ping")["ok"] == 1.0
    qdrant.create_collection(
      collection_name=collection_name,
      vectors_config=qmodels.VectorParams(size=3, distance=qmodels.Distance.COSINE),
    )
    for field in (
      "tenant_id",
      "user_id",
      "memory_id",
      "memory_type",
      "projection_version",
      "status",
    ):
      qdrant.create_payload_index(
        collection_name=collection_name,
        field_name=field,
        field_schema=qmodels.PayloadSchemaType.KEYWORD,
        wait=True,
      )
    qdrant.create_payload_index(
      collection_name=collection_name,
      field_name="expires_at",
      field_schema=qmodels.PayloadSchemaType.DATETIME,
      wait=True,
    )
    database = mongo[database_name]
    repository = MongoMemoryRepository(
      database.memory_records,
      database.memory_idempotency,
      client=mongo,
    )
    embedding = ConstantEmbedding()
    projection = QdrantMemoryProjection(
      qdrant,
      collection_name=collection_name,
      projection_version="memory-projection-v1",
    )
    index = QdrantMemoryCandidateIndex(
      qdrant,
      embedding,
      collection_name=collection_name,
      clock=clock,
    )
    application = MemoryApplication(
      repository,
      verifier,
      clock,
      candidate_index=index,
      policy=policy,
    )
    reconciler = MemoryProjectionReconciler(repository, projection, embedding, clock)

    content = "Prefer concise Polish responses"
    create = CreateConfirmedMemory(
      scope=scope,
      memory_id="preference-1",
      memory_type="communication_preference",
      conflict_key="response-style",
      content=content,
      source_event_id="runtime-event-1",
      provenance="explicit local runtime confirmation",
      confidence=1,
      salience=0.8,
      retention_class="user_controlled",
      expires_at=now + timedelta(days=30),
      receipt=receipt(
        "create",
        "preference-1",
        content,
        memory_type="communication_preference",
        conflict_key="response-style",
        source_event_id="runtime-event-1",
        provenance="explicit local runtime confirmation",
        confidence=1,
        salience=0.8,
        retention_class="user_controlled",
        expires_at=now + timedelta(days=30),
      ),
      idempotency_key="runtime-create-1",
    )
    created = application.create(create)
    assert application.create(create) == created
    assert reconciler.reconcile(scope) == {
      "projected": 1,
      "deleted": 0,
      "orphans_deleted": 0,
    }
    point, _ = qdrant.scroll(
      collection_name=collection_name,
      limit=10,
      with_payload=True,
      with_vectors=False,
    )
    assert len(point) == 1
    assert content not in repr(point[0].payload)
    assert [item.memory.memory_id for item in application.search(scope, "Polish", limit=3)] == [
      "preference-1"
    ]
    foreign = MemoryScope(tenant_id=scope.tenant_id, user_id="foreign-user")
    assert not application.search(foreign, "Polish", limit=3)
    foreign_tenant = MemoryScope(tenant_id="foreign-tenant", user_id=scope.user_id)
    assert not application.search(foreign_tenant, "Polish", limit=3)

    # Qdrant is only a candidate projection: a checksum mismatch is rejected
    # until reconciliation rebuilds the point from canonical MongoDB.
    qdrant.set_payload(
      collection_name=collection_name,
      payload={"checksum": "0" * 64},
      points=[point[0].id],
      wait=True,
    )
    assert not application.search(scope, "Polish", limit=3)
    assert reconciler.reconcile(scope)["projected"] == 1
    assert [item.memory.memory_id for item in application.search(scope, "Polish", limit=3)] == [
      "preference-1"
    ]

    # The active conflict index is the final concurrent-write guard. Its
    # duplicate-key failure must roll back the idempotency receipt as well.
    conflicting = created.model_copy(
      update={
        "memory_id": "preference-conflict",
        "content": "Prefer verbose replies",
        "checksum": content_checksum("Prefer verbose replies"),
      }
    )
    with pytest.raises(MemoryConflict):
      repository.save(conflicting, "runtime-conflict-rollback")
    assert repository.get(scope, "preference-conflict") is None
    assert database.memory_idempotency.find_one(
      {"idempotency_key": "runtime-conflict-rollback"}
    ) is None

    # Prove physical removal of a projection that has no canonical record.
    orphan_id = uuid4().hex
    qdrant.upsert(
      collection_name=collection_name,
      points=[
        qmodels.PointStruct(
          id=orphan_id,
          vector=[1.0, 1.0, 0.5],
          payload={
            "tenant_id": scope.tenant_id,
            "user_id": scope.user_id,
            "memory_id": "orphan-memory",
            "memory_type": "communication_preference",
            "checksum": "0" * 64,
            "projection_version": "memory-projection-v1",
            "expires_at": (now + timedelta(days=1)).isoformat(),
            "status": MemoryStatus.ACTIVE.value,
          },
        )
      ],
      wait=True,
    )
    assert reconciler.reconcile(scope) == {
      "projected": 1,
      "deleted": 0,
      "orphans_deleted": 1,
    }

    replacement_content = "Prefer concise Polish responses with bullet lists"
    supersede = SupersedeMemory(
      scope=scope,
      memory_id="preference-1",
      replacement_id="preference-2",
      content=replacement_content,
      receipt=receipt(
        "supersede",
        "preference-1",
        replacement_content,
        replacement_id="preference-2",
      ),
      idempotency_key="runtime-supersede-1",
    )
    replacement = application.supersede(supersede)
    assert application.supersede(supersede) == replacement
    assert application.get(scope, "preference-1").status is MemoryStatus.SUPERSEDED
    assert reconciler.reconcile(scope) == {
      "projected": 1,
      "deleted": 1,
      "orphans_deleted": 0,
    }

    revoke = RevokeConsent(
      scope=scope,
      memory_id="preference-2",
      receipt=receipt("revoke", "preference-2", ""),
      idempotency_key="runtime-revoke-1",
    )
    revoked = application.revoke(revoke)
    clock.value = now + timedelta(seconds=1)
    assert application.revoke(revoke) == revoked
    assert reconciler.reconcile(scope) == {
      "projected": 0,
      "deleted": 1,
      "orphans_deleted": 0,
    }

    delete = DeleteMemory(
      scope=scope,
      memory_id="preference-2",
      receipt=receipt("delete", "preference-2", ""),
      idempotency_key="runtime-delete-1",
    )
    deleted = application.delete(delete)
    clock.value = now + timedelta(seconds=2)
    assert application.delete(delete) == deleted
    assert reconciler.reconcile(scope) == {
      "projected": 0,
      "deleted": 0,
      "orphans_deleted": 0,
    }
    assert deleted.status is MemoryStatus.DELETED
    assert deleted.content == "[deleted]"
    assert not application.search(scope, "Polish", limit=3)
    remaining, _ = qdrant.scroll(collection_name=collection_name, limit=10)
    assert remaining == []
  finally:
    mongo.drop_database(database_name)
    if qdrant.collection_exists(collection_name):
      qdrant.delete_collection(collection_name=collection_name)
    qdrant.close()
    mongo.close()
