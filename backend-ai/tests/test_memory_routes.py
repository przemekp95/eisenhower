from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from app.auth import AuthError, AuthPrincipal
from app.audit import AuditAction, AuditOutcome
from app.config import Settings
from app.main import create_app
from app.memory.adapters import HmacConsentReceiptVerifier
from app.memory.application import MemoryApplication, MemoryConflict
from app.memory.models import MemoryScope, ProjectionCandidate
from app.memory.policy import MemoryPolicy
from app.memory.runtime import MemoryRuntime


NOW = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)


class Clock:
  def now(self):
    return NOW


class Repository:
  def __init__(self):
    self.records = {}
    self.idempotency = {}

  def save(self, record, idempotency_key):
    prior = self.idempotency.get(idempotency_key)
    if prior is not None and prior != record:
      raise MemoryConflict("idempotency key reused")
    self.records[(record.scope.tenant_id, record.scope.user_id, record.memory_id)] = record
    self.idempotency[idempotency_key] = record
    return record

  def supersede(self, previous, replacement, idempotency_key):
    prior = self.idempotency.get(idempotency_key)
    if prior is not None:
      return prior
    self.records[(previous.scope.tenant_id, previous.scope.user_id, previous.memory_id)] = previous
    self.records[(replacement.scope.tenant_id, replacement.scope.user_id, replacement.memory_id)] = replacement
    self.idempotency[idempotency_key] = replacement
    return replacement

  def get(self, scope, memory_id):
    return self.records.get((scope.tenant_id, scope.user_id, memory_id))

  def list(self, scope):
    return [
      record
      for (tenant_id, user_id, _), record in self.records.items()
      if (tenant_id, user_id) == (scope.tenant_id, scope.user_id)
    ]


class Index:
  def __init__(self, repository):
    self.repository = repository

  def search_ids(self, scope, _text, limit):
    return [
      ProjectionCandidate(
        memory_id=record.memory_id,
        score=0.9,
        projection_version="memory-projection-v1",
        checksum=record.checksum,
      )
      for record in self.repository.list(scope)
    ][:limit]


class Reconciler:
  def __init__(self, *, fail=False):
    self.scopes = []
    self.fail = fail

  def reconcile(self, scope):
    self.scopes.append(scope)
    if self.fail:
      raise RuntimeError("projection unavailable")
    return {"projected": 1, "deleted": 0, "orphans_deleted": 0}


class FakeAIService:
  local_model = object()

  def capabilities(self):
    return {
      "classification": True,
      "reasoned_local_analysis": True,
      "knowledge_retrieval": False,
      "retrieval_augmented_generation": False,
      "local_similar_examples": True,
      "ocr": False,
      "batch_analysis": True,
      "model": {"generation_id": "test"},
    }


class MultiTenantVerifier:
  def verify(self, token):
    identities = {
      "tenant-one": AuthPrincipal(
        tenant_id="tenant-1",
        user_id="user-1",
        roles=["user"],
        scopes=["memory:read", "memory:write"],
      ),
      "tenant-two": AuthPrincipal(
        tenant_id="tenant-2",
        user_id="user-2",
        roles=["user"],
        scopes=["memory:read", "memory:write"],
      ),
    }
    if token not in identities:
      raise AuthError("unknown token")
    return identities[token]


class RecordingAuditSink:
  def __init__(self):
    self.events = []

  def record(self, event):
    self.events.append(event)
    return event


def policy() -> MemoryPolicy:
  root = Path(__file__).resolve().parents[2]
  return MemoryPolicy.load(root / "docs" / "ai-rebuild" / "memory-policy-v1.json")


def runtime():
  repository = Repository()
  verifier = HmacConsentReceiptVerifier({"runtime": b"m" * 32})
  clock = Clock()
  application = MemoryApplication(
    repository,
    verifier,
    clock,
    candidate_index=Index(repository),
    policy=policy(),
  )
  return MemoryRuntime(
    application=application,
    confirmation_signer=verifier,
    clock=clock,
    policy=policy(),
    reconciler=Reconciler(),
  )


def settings(tmp_path, *, enabled=True):
  root = Path(__file__).resolve().parents[2]
  return Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    memory_write_enabled=enabled,
    memory_retrieval_enabled=enabled,
    memory_policy_path=(root / "docs" / "ai-rebuild" / "memory-policy-v1.json") if enabled else None,
    memory_consent_hmac_key="m" * 32 if enabled else None,
  )


def client(tmp_path, *, enabled=True):
  memory_runtime = runtime() if enabled else None
  return TestClient(
    create_app(
      settings=settings(tmp_path, enabled=enabled),
      ai_service=FakeAIService(),
      memory_runtime=memory_runtime,
    ),
    headers={"Authorization": "Bearer test-api-token"},
  ), memory_runtime


def create_intent():
  return {
    "action": "create",
    "memory_id": "preference-1",
    "memory_type": "communication_preference",
    "conflict_key": "response-style",
    "content": "Prefer concise Polish responses",
    "source_event_id": "memory-control-1",
    "provenance": "explicit memory control",
    "confidence": 1,
    "salience": 0.8,
    "retention_class": "user_controlled",
    "expires_at": (NOW + timedelta(days=30)).isoformat(),
  }


def prepare_and_confirm(client, intent, *, idempotency_key):
  prepared = client.post("/v2/memory/prepare", json=intent)
  assert prepared.status_code == 200, prepared.text
  confirmed = client.post(
    "/v2/memory/confirm",
    json={"intent": intent, "receipt": prepared.json()["receipt"]},
    headers={"Idempotency-Key": idempotency_key},
  )
  return prepared, confirmed


def test_memory_routes_are_absent_when_rollout_flags_are_disabled(tmp_path):
  api, _ = client(tmp_path, enabled=False)

  assert api.post("/v2/memory/prepare", json=create_intent()).status_code == 404
  assert api.get("/v2/memory/export").status_code == 404
  capabilities = api.get("/capabilities").json()
  assert {
    key: capabilities[key]
    for key in ("memory_write", "memory_retrieval", "memory_response")
  } == {"memory_write": False, "memory_retrieval": False, "memory_response": False}


def test_prepare_and_confirm_derives_scope_from_bearer_and_is_idempotent(tmp_path):
  api, memory_runtime = client(tmp_path)

  capabilities = api.get("/capabilities").json()
  assert {
    key: capabilities[key]
    for key in ("memory_write", "memory_retrieval", "memory_response")
  } == {"memory_write": True, "memory_retrieval": True, "memory_response": False}

  prepared, confirmed = prepare_and_confirm(
    api,
    create_intent(),
    idempotency_key="create-preference-1",
  )

  assert prepared.json()["action"] == "create"
  assert prepared.json()["memory_id"] == "preference-1"
  assert not memory_runtime.application.export(MemoryScope(tenant_id="local", user_id="foreign"))
  assert confirmed.status_code == 200
  assert confirmed.json() == {
    "memory_id": "preference-1",
    "status": "active",
    "projection_state": "synchronized",
  }
  replay = api.post(
    "/v2/memory/confirm",
    json={"intent": create_intent(), "receipt": prepared.json()["receipt"]},
    headers={"Idempotency-Key": "create-preference-1"},
  )
  assert replay.status_code == 200
  assert len(memory_runtime.application.export(MemoryScope(tenant_id="local", user_id="local-user"))) == 1


def test_confirm_rejects_tampering_missing_bearer_and_untrusted_origin(tmp_path):
  api, _ = client(tmp_path)
  intent = create_intent()
  prepared = api.post("/v2/memory/prepare", json=intent).json()
  tampered = {**intent, "content": "Store a different value"}

  rejected = api.post(
    "/v2/memory/confirm",
    json={"intent": tampered, "receipt": prepared["receipt"]},
    headers={"Idempotency-Key": "tampered"},
  )
  assert rejected.status_code == 403
  assert rejected.json() == {"error": "Explicit memory confirmation is invalid."}

  missing_auth = api.post(
    "/v2/memory/prepare",
    json=intent,
    headers={"Authorization": ""},
  )
  assert missing_auth.status_code == 401

  foreign_origin = api.post(
    "/v2/memory/prepare",
    json=intent,
    headers={"Origin": "https://attacker.example"},
  )
  assert foreign_origin.status_code == 403

  body_scope = api.post(
    "/v2/memory/prepare",
    json={**intent, "scope": {"tenant_id": "other", "user_id": "other"}},
  )
  assert body_scope.status_code == 422


def test_export_redacts_receipt_secret_and_retrieval_is_shadow_only(tmp_path):
  api, _ = client(tmp_path)
  _, confirmed = prepare_and_confirm(api, create_intent(), idempotency_key="create-1")
  assert confirmed.status_code == 200

  exported = api.get("/v2/memory/export")
  assert exported.status_code == 200
  assert exported.json()["items"][0]["content"] == "Prefer concise Polish responses"
  assert "confirmation_id" not in repr(exported.json())

  shadow = api.post("/v2/memory/retrieval-shadow", json={"query": "Polish", "limit": 3})
  assert shadow.status_code == 200
  assert shadow.json() == {
    "mode": "shadow",
    "hit_count": 1,
    "response_augmented": False,
  }
  assert "Prefer concise Polish responses" not in shadow.text


def test_revoke_and_delete_require_separate_fresh_confirmations(tmp_path):
  api, _ = client(tmp_path)
  _, created = prepare_and_confirm(api, create_intent(), idempotency_key="create-1")
  assert created.status_code == 200

  revoke = {"action": "revoke", "memory_id": "preference-1"}
  _, revoked = prepare_and_confirm(api, revoke, idempotency_key="revoke-1")
  assert revoked.status_code == 200
  assert revoked.json()["status"] == "consent_revoked"

  delete = {"action": "delete", "memory_id": "preference-1"}
  _, deleted = prepare_and_confirm(api, delete, idempotency_key="delete-1")
  assert deleted.status_code == 200
  assert deleted.json()["status"] == "deleted"


def test_projection_failure_does_not_rollback_canonical_confirmed_write(tmp_path):
  memory_runtime = runtime()
  memory_runtime.reconciler.fail = True
  api = TestClient(
    create_app(
      settings=settings(tmp_path),
      ai_service=FakeAIService(),
      memory_runtime=memory_runtime,
    ),
    headers={"Authorization": "Bearer test-api-token"},
  )

  _, confirmed = prepare_and_confirm(api, create_intent(), idempotency_key="create-1")

  assert confirmed.status_code == 200
  assert confirmed.json()["projection_state"] == "pending"
  scope = MemoryScope(tenant_id="local", user_id="local-user")
  assert memory_runtime.application.get(scope, "preference-1").content == (
    "Prefer concise Polish responses"
  )


def test_idempotency_keys_are_namespaced_by_server_derived_identity(tmp_path):
  memory_runtime = runtime()
  api = TestClient(create_app(
    settings=settings(tmp_path),
    ai_service=FakeAIService(),
    memory_runtime=memory_runtime,
    token_verifier=MultiTenantVerifier(),
  ))
  shared_key = "shared-client-key"

  for token in ("tenant-one", "tenant-two"):
    headers = {"Authorization": f"Bearer {token}"}
    intent = create_intent()
    prepared = api.post("/v2/memory/prepare", json=intent, headers=headers)
    confirmed = api.post(
      "/v2/memory/confirm",
      json={"intent": intent, "receipt": prepared.json()["receipt"]},
      headers={**headers, "Idempotency-Key": shared_key},
    )
    assert confirmed.status_code == 200, confirmed.text

  assert len(memory_runtime.application.repository.idempotency) == 2


def test_export_is_audited_without_recording_memory_content(tmp_path):
  memory_runtime = runtime()
  audit = RecordingAuditSink()
  api = TestClient(
    create_app(
      settings=settings(tmp_path),
      ai_service=FakeAIService(),
      memory_runtime=memory_runtime,
      audit_sink=audit,
    ),
    headers={"Authorization": "Bearer test-api-token"},
  )
  _, created = prepare_and_confirm(api, create_intent(), idempotency_key="create-1")
  assert created.status_code == 200
  audit.events.clear()

  exported = api.get("/v2/memory/export")

  assert exported.status_code == 200
  assert [(event.action, event.outcome) for event in audit.events] == [
    (AuditAction.MEMORY_EXPORT, AuditOutcome.ATTEMPT),
    (AuditAction.MEMORY_EXPORT, AuditOutcome.SUCCESS),
  ]
  assert all("Prefer concise Polish responses" not in repr(event) for event in audit.events)
