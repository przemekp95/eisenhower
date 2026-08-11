from datetime import datetime, timedelta, timezone

import pytest

from app.memory.application import MemoryApplication, MemoryConflict, MemoryPolicyError
from app.memory.commands import CreateConfirmedMemory, DeleteMemory, RevokeConsent, SupersedeMemory
from app.memory.models import ConsentReceipt, MemoryScope, MemoryStatus, intent_checksum


NOW = datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)
SCOPE = MemoryScope(tenant_id="tenant-1", user_id="user-1")


class Clock:
  def __init__(self):
    self.value = NOW

  def now(self):
    return self.value


class Verifier:
  def verify(self, receipt):
    return receipt.confirmation_id != "invalid"


class Repository:
  def __init__(self):
    self.records = {}
    self.idempotency = {}

  def save(self, record, idempotency_key):
    prior = self.idempotency.get(idempotency_key)
    if prior and prior != record:
      raise MemoryConflict("idempotency key reused")
    self.records[(record.scope.tenant_id, record.scope.user_id, record.memory_id)] = record
    self.idempotency[idempotency_key] = record
    return record

  def get(self, scope, memory_id):
    return self.records.get((scope.tenant_id, scope.user_id, memory_id))

  def supersede(self, previous, replacement, idempotency_key):
    prior = self.idempotency.get(idempotency_key)
    if prior:
      return self.get(replacement.scope, prior)
    self.records[(previous.scope.tenant_id, previous.scope.user_id, previous.memory_id)] = previous
    self.records[(replacement.scope.tenant_id, replacement.scope.user_id, replacement.memory_id)] = replacement
    self.idempotency[idempotency_key] = replacement.memory_id
    return replacement

  def list(self, scope):
    return [r for (tenant, user, _), r in self.records.items() if (tenant, user) == (scope.tenant_id, scope.user_id)]


def make_receipt(action, checksum, **overrides):
  values = {
    "confirmation_id": f"confirm-{action}",
    "actor_user_id": SCOPE.user_id,
    "action": action,
    "intent_checksum": checksum,
    "policy_version": "consent-v1",
    "confirmed_at": NOW,
    "expires_at": NOW + timedelta(minutes=5),
  }
  values.update(overrides)
  return ConsentReceipt(**values)


def create_command(memory_id="memory-1", content="Prefer Polish responses", **overrides):
  values = {
    "scope": SCOPE,
    "memory_id": memory_id,
    "memory_type": "preference",
    "conflict_key": "response-language",
    "content": content,
    "source_event_id": "event-1",
    "provenance": "explicit user confirmation",
    "confidence": 1,
    "salience": 0.8,
    "retention_class": "user-controlled",
    "expires_at": NOW + timedelta(days=30),
    "idempotency_key": f"create-{memory_id}",
  }
  values.update(overrides)
  if "receipt" not in values:
    checksum = intent_checksum(
      "create",
      values["scope"],
      values["memory_id"],
      values["content"],
      memory_type=values["memory_type"],
      conflict_key=values["conflict_key"],
      source_event_id=values["source_event_id"],
      provenance=values["provenance"],
      confidence=values["confidence"],
      salience=values["salience"],
      retention_class=values["retention_class"],
      expires_at=values["expires_at"],
    )
    values["receipt"] = make_receipt("create", checksum)
  return CreateConfirmedMemory(**values)


def app(*, repository=None, clock=None):
  return MemoryApplication(repository or Repository(), Verifier(), clock or Clock())


def test_create_requires_actor_action_intent_and_unexpired_confirmation():
  service = app()
  assert service.create(create_command()).status is MemoryStatus.ACTIVE

  for receipt in (
    make_receipt("create", "0" * 64, actor_user_id="foreign-user"),
    make_receipt("delete", "0" * 64),
    make_receipt("create", "0" * 64),
    make_receipt(
      "create",
      create_command().receipt.intent_checksum,
      confirmed_at=NOW - timedelta(minutes=10),
      expires_at=NOW,
    ),
  ):
    with pytest.raises(MemoryPolicyError):
      service.create(create_command(receipt=receipt, idempotency_key=f"bad-{receipt.action}-{receipt.actor_user_id}-{receipt.intent_checksum}"))


def test_create_is_idempotent_and_rejects_cross_scope_access():
  service = app()
  command = create_command()
  assert service.create(command) == service.create(command)
  foreign = MemoryScope(tenant_id="tenant-2", user_id="user-1")
  with pytest.raises(MemoryPolicyError):
    service.get(foreign, "memory-1")


def test_create_surfaces_active_subject_conflicts_until_user_supersedes():
  service = app()
  service.create(create_command())

  with pytest.raises(MemoryConflict, match="explicit supersession"):
    service.create(
      create_command(
        memory_id="memory-2",
        content="Prefer English responses",
        conflict_key="response-language",
      )
    )


@pytest.mark.parametrize(
  "update",
  [
    {"memory_type": "project_context"},
    {"conflict_key": "different-subject"},
    {"source_event_id": "different-event"},
    {"provenance": "different provenance"},
    {"confidence": 0.1},
    {"salience": 0.1},
    {"retention_class": "session"},
    {"expires_at": NOW + timedelta(days=1)},
  ],
)
def test_create_confirmation_binds_every_persisted_user_controlled_field(update):
  command = create_command()
  with pytest.raises(MemoryPolicyError, match="confirmation"):
    app().create(command.model_copy(update=update))


def test_supersede_revoke_and_delete_are_explicit_and_conflicts_surface():
  service = app()
  service.create(create_command())

  new_content = "Prefer concise Polish responses"
  supersede = SupersedeMemory(
    scope=SCOPE,
    memory_id="memory-1",
    replacement_id="memory-2",
    content=new_content,
    receipt=make_receipt(
      "supersede",
      intent_checksum(
        "supersede",
        SCOPE,
        "memory-1",
        new_content,
        replacement_id="memory-2",
      ),
    ),
    idempotency_key="supersede-1",
  )
  replacement = service.supersede(supersede)
  assert replacement.status is MemoryStatus.ACTIVE
  assert service.get(SCOPE, "memory-1").status is MemoryStatus.SUPERSEDED
  assert service.supersede(supersede) == replacement
  with pytest.raises(MemoryPolicyError):
    service.supersede(supersede.model_copy(update={"replacement_id": "memory-3", "idempotency_key": "supersede-2"}))

  revoke = RevokeConsent(
    scope=SCOPE,
    memory_id="memory-2",
    receipt=make_receipt("revoke", intent_checksum("revoke", SCOPE, "memory-2", "")),
    idempotency_key="revoke-1",
  )
  assert service.revoke(revoke).status is MemoryStatus.CONSENT_REVOKED

  delete = DeleteMemory(
    scope=SCOPE,
    memory_id="memory-2",
    receipt=make_receipt("delete", intent_checksum("delete", SCOPE, "memory-2", "")),
    idempotency_key="delete-1",
  )
  deleted = service.delete(delete)
  assert deleted.status is MemoryStatus.DELETED
  assert deleted.content == "[deleted]"
  assert "concise Polish" not in deleted.content


def test_revoke_and_delete_replays_return_the_durable_result_after_time_moves():
  repository = Repository()
  clock = Clock()
  service = app(repository=repository, clock=clock)
  service.create(create_command())
  revoke = RevokeConsent(
    scope=SCOPE,
    memory_id="memory-1",
    receipt=make_receipt("revoke", intent_checksum("revoke", SCOPE, "memory-1", "")),
    idempotency_key="revoke-replay",
  )

  revoked = service.revoke(revoke)
  clock.value += timedelta(seconds=30)
  assert service.revoke(revoke) == revoked

  delete = DeleteMemory(
    scope=SCOPE,
    memory_id="memory-1",
    receipt=make_receipt("delete", intent_checksum("delete", SCOPE, "memory-1", "")),
    idempotency_key="delete-replay",
  )
  deleted = service.delete(delete)
  clock.value += timedelta(seconds=30)
  assert service.delete(delete) == deleted
