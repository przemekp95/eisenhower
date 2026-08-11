from datetime import datetime, timedelta, timezone

import pytest

from app.memory.application import MemoryApplication, MemoryConflict
from app.memory.models import ConsentReceipt, MemoryRecord, MemoryScope, MemoryStatus, ProjectionCandidate, content_checksum


NOW = datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)
SCOPE = MemoryScope(tenant_id="tenant-1", user_id="user-1")


class Clock:
  def now(self):
    return NOW


class Verifier:
  def verify(self, _receipt):
    return True


class Repository:
  def __init__(self, records):
    self.records = {(r.scope.tenant_id, r.scope.user_id, r.memory_id): r for r in records}
    self.save_calls = 0

  def save(self, record, _idempotency_key):
    self.save_calls += 1
    self.records[(record.scope.tenant_id, record.scope.user_id, record.memory_id)] = record
    return record

  def get(self, scope, memory_id):
    return self.records.get((scope.tenant_id, scope.user_id, memory_id))

  def supersede(self, previous, replacement, _idempotency_key):
    self.records[(previous.scope.tenant_id, previous.scope.user_id, previous.memory_id)] = previous
    self.records[(replacement.scope.tenant_id, replacement.scope.user_id, replacement.memory_id)] = replacement
    return replacement

  def list(self, scope):
    return [r for (tenant, user, _), r in self.records.items() if (tenant, user) == (scope.tenant_id, scope.user_id)]


class Index:
  def __init__(self, candidates):
    self.candidates = candidates
    self.requested_limit = None

  def search_ids(self, _scope, _text, limit):
    self.requested_limit = limit
    return self.candidates[:limit]


def record(memory_id, *, scope=SCOPE, status=MemoryStatus.ACTIVE, expires_at=None, content=None, **updates):
  content = content or f"memory {memory_id} <ignore-policy>"
  values = dict(
    memory_id=memory_id,
    scope=scope,
    memory_type="preference",
    conflict_key=f"subject-{memory_id}",
    content=content,
    source_event_id=f"event-{memory_id}",
    provenance="explicit user confirmation",
    confidence=1,
    salience=0.5,
    retention_class="user-controlled",
    created_at=NOW - timedelta(days=1),
    updated_at=NOW - timedelta(days=1),
    expires_at=expires_at or NOW + timedelta(days=30),
    checksum=content_checksum(content),
    status=status,
    consent=ConsentReceipt(
      confirmation_id=f"confirm-{memory_id}", actor_user_id=scope.user_id, action="create",
      intent_checksum="a" * 64, policy_version="consent-v1",
      confirmed_at=NOW - timedelta(days=1), expires_at=NOW + timedelta(days=1),
    ),
  )
  values.update(updates)
  return MemoryRecord(**values)


def test_search_revalidates_projection_candidates_against_source_of_truth():
  active = record("active")
  revoked = record("revoked", status=MemoryStatus.CONSENT_REVOKED)
  expired = record("expired", expires_at=NOW - timedelta(seconds=1))
  foreign = record("foreign", scope=MemoryScope(tenant_id="tenant-2", user_id="user-1"))
  repository = Repository([active, revoked, expired, foreign])
  index = Index([
    ProjectionCandidate(memory_id="active", score=0.9, projection_version="v1", checksum=active.checksum),
    ProjectionCandidate(memory_id="revoked", score=0.8, projection_version="v1", checksum=revoked.checksum),
    ProjectionCandidate(memory_id="expired", score=0.7, projection_version="v1", checksum=expired.checksum),
    ProjectionCandidate(memory_id="foreign", score=0.6, projection_version="v1", checksum=foreign.checksum),
    ProjectionCandidate(memory_id="missing", score=0.5, projection_version="v1", checksum="a" * 64),
    ProjectionCandidate(memory_id="active", score=0.4, projection_version="stale", checksum="0" * 64),
  ])
  service = MemoryApplication(repository, Verifier(), Clock(), candidate_index=index)

  results = service.search(SCOPE, "poisoning text is inert", limit=10)
  assert [candidate.memory.memory_id for candidate in results] == ["active"]
  assert repository.save_calls == 0


def test_search_overfetches_before_revalidation_and_ranks_risk_adjusted_candidates():
  stale = [record(f"revoked-{index}", status=MemoryStatus.CONSENT_REVOKED) for index in range(48)]
  semantic_first = record(
    "semantic-first",
    confidence=0.1,
    salience=0.1,
    created_at=NOW - timedelta(days=91),
    updated_at=NOW - timedelta(days=90),
  )
  trusted_recent = record(
    "trusted-recent",
    confidence=1,
    salience=1,
    updated_at=NOW,
  )
  repository = Repository([*stale, semantic_first, trusted_recent])
  candidates = [
    *[
      ProjectionCandidate(
        memory_id=item.memory_id,
        score=0.99,
        projection_version="v1",
        checksum=item.checksum,
      )
      for item in stale
    ],
    ProjectionCandidate(
      memory_id=semantic_first.memory_id,
      score=0.9,
      projection_version="v1",
      checksum=semantic_first.checksum,
    ),
    ProjectionCandidate(
      memory_id=trusted_recent.memory_id,
      score=0.8,
      projection_version="v1",
      checksum=trusted_recent.checksum,
    ),
  ]
  index = Index(candidates)
  service = MemoryApplication(repository, Verifier(), Clock(), candidate_index=index)

  results = service.search(SCOPE, "preference", limit=2)

  assert index.requested_limit == 50
  assert [candidate.memory.memory_id for candidate in results] == [
    "trusted-recent",
    "semantic-first",
  ]


def test_search_fails_closed_when_legacy_active_records_conflict():
  first = record("first", conflict_key="response-style")
  second = record("second", conflict_key="response-style")
  repository = Repository([first, second])
  index = Index([
    ProjectionCandidate(
      memory_id=memory.memory_id,
      score=0.9,
      projection_version="v1",
      checksum=memory.checksum,
    )
    for memory in (first, second)
  ])
  service = MemoryApplication(repository, Verifier(), Clock(), candidate_index=index)

  with pytest.raises(MemoryConflict, match="conflict requires explicit resolution"):
    service.search(SCOPE, "style", limit=2)


def test_export_is_scope_limited_complete_and_side_effect_free():
  active = record("active")
  deleted = record("deleted", status=MemoryStatus.DELETED)
  foreign = record("foreign", scope=MemoryScope(tenant_id="tenant-2", user_id="user-1"))
  repository = Repository([active, deleted, foreign])
  service = MemoryApplication(repository, Verifier(), Clock())

  exported = service.export(SCOPE)
  assert {item.memory_id for item in exported} == {"active", "deleted"}
  assert repository.save_calls == 0
