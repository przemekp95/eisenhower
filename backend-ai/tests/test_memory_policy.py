from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.memory.application import MemoryApplication, MemoryPolicyError
from app.memory.commands import CreateConfirmedMemory
from app.memory.models import ConsentReceipt, MemoryScope, intent_checksum
from app.memory.policy import MemoryPolicy, MemoryPolicyViolation, canonical_policy_sha256


NOW = datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)
SCOPE = MemoryScope(tenant_id="tenant-1", user_id="user-1")


class Clock:
  def now(self):
    return NOW


class Verifier:
  def verify(self, _receipt):
    return True


class Repository:
  def __init__(self):
    self.records = {}

  def save(self, record, _idempotency_key):
    self.records[(record.scope.tenant_id, record.scope.user_id, record.memory_id)] = record
    return record

  def get(self, scope, memory_id):
    return self.records.get((scope.tenant_id, scope.user_id, memory_id))

  def list(self, scope):
    return [
      record for (tenant, user, _), record in self.records.items()
      if (tenant, user) == (scope.tenant_id, scope.user_id)
    ]


def frozen_policy() -> MemoryPolicy:
  root = Path(__file__).resolve().parents[2]
  return MemoryPolicy.load(root / "docs" / "ai-rebuild" / "memory-policy-v1.json")


def command(**overrides) -> CreateConfirmedMemory:
  content = overrides.pop("content", "Prefer concise Polish responses")
  memory_id = overrides.pop("memory_id", "memory-1")
  values = {
    "scope": SCOPE,
    "memory_id": memory_id,
    "memory_type": "communication_preference",
    "conflict_key": "response-style",
    "content": content,
    "source_event_id": "explicit-form-1",
    "provenance": "explicit user confirmation in the memory control",
    "confidence": 1,
    "salience": 0.8,
    "retention_class": "user_controlled",
    "expires_at": NOW + timedelta(days=30),
    "idempotency_key": "create-memory-1",
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
    values["receipt"] = ConsentReceipt(
      confirmation_id="confirmation-1",
      actor_user_id=SCOPE.user_id,
      action="create",
      intent_checksum=checksum,
      policy_version="eisenhower-memory-consent-v1",
      confirmed_at=NOW,
      expires_at=NOW + timedelta(minutes=5),
    )
  return CreateConfirmedMemory(**values)


def test_repository_memory_policy_is_frozen_fail_closed_and_rollout_disabled():
  policy = frozen_policy()
  root = Path(__file__).resolve().parents[2]

  assert policy.policy_version == "eisenhower-memory-consent-v1"
  assert policy.rollout.write_enabled is False
  assert policy.rollout.retrieval_enabled is False
  assert policy.rollout.response_enabled is False
  assert policy.projection.qdrant_raw_content_payload is False
  assert len(canonical_policy_sha256(root / "docs" / "ai-rebuild" / "memory-policy-v1.json")) == 64


def test_policy_accepts_only_approved_type_retention_and_secret_free_content():
  policy = frozen_policy()
  service = MemoryApplication(Repository(), Verifier(), Clock(), policy=policy)

  assert service.create(command()).memory_type == "communication_preference"

  with pytest.raises(MemoryPolicyViolation, match="type"):
    service.create(command(memory_id="memory-2", memory_type="health"))
  with pytest.raises(MemoryPolicyViolation, match="secret"):
    service.create(command(
      memory_id="memory-3",
      content="api_key: abcdefghijklmnop",
      idempotency_key="create-memory-3",
    ))
  with pytest.raises(MemoryPolicyViolation, match="retention"):
    service.create(command(memory_id="memory-4", expires_at=NOW + timedelta(days=31)))


def test_policy_version_and_confirmation_ttl_are_enforced():
  policy = frozen_policy()
  service = MemoryApplication(Repository(), Verifier(), Clock(), policy=policy)
  valid = command()

  with pytest.raises(MemoryPolicyError):
    service.create(valid.model_copy(update={
      "receipt": valid.receipt.model_copy(update={"policy_version": "stale-policy"})
    }))
  with pytest.raises(MemoryPolicyViolation, match="TTL"):
    service.create(valid.model_copy(update={
      "receipt": valid.receipt.model_copy(update={
        "expires_at": valid.receipt.confirmed_at + timedelta(minutes=6)
      })
    }))


@pytest.mark.parametrize(
  ("section", "field", "value"),
  [
    ("identity", "scope_from_request_body", True),
    ("consent", "intent_bound_fields", {"create": ["action", "content"]}),
    ("lifecycle", "expired_status_is_retrievable", True),
    ("projection", "qdrant_payload_fields", ["memory_id", "content"]),
    ("prompt_budget", "render_as_untrusted_user_data", False),
    ("rollout", "write_enabled", True),
  ],
)
def test_policy_rejects_security_contract_drift(section, field, value):
  path = Path(__file__).resolve().parents[2] / "docs" / "ai-rebuild" / "memory-policy-v1.json"
  policy = json.loads(path.read_text(encoding="utf-8"))
  policy[section][field] = value

  with pytest.raises(ValidationError):
    MemoryPolicy.model_validate(policy)
