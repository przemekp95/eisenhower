from __future__ import annotations

from hashlib import sha256

from app.audit import AuditAction, AuditEvent, AuditOutcome

from .commands import CreateConfirmedMemory, DeleteMemory, RevokeConsent, SupersedeMemory
from .models import (
  ConsentReceipt,
  MemoryAction,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  RevalidatedMemoryCandidate,
  content_checksum,
  intent_checksum,
)
from .ports import Clock, ConfirmationVerifier, MemoryCandidateIndex, MemoryRepository
from .policy import MemoryPolicy


class MemoryPolicyError(ValueError):
  pass


class MemoryConflict(RuntimeError):
  pass


class MemoryApplication:
  def __init__(
    self,
    repository: MemoryRepository,
    confirmation_verifier: ConfirmationVerifier,
    clock: Clock,
    *,
    candidate_index: MemoryCandidateIndex | None = None,
    policy: MemoryPolicy | None = None,
    audit_sink=None,
    audit_release_sha: str = "0" * 40,
  ):
    self.repository = repository
    self.confirmation_verifier = confirmation_verifier
    self.clock = clock
    self.candidate_index = candidate_index
    self.policy = policy
    self.audit_sink = audit_sink
    self.audit_release_sha = audit_release_sha

  def _audit(self, command, action: AuditAction, outcome: AuditOutcome) -> None:
    if self.audit_sink is None:
      return
    identity = f"{command.idempotency_key}:{action.value}:{outcome.value}"
    self.audit_sink.record(
      AuditEvent(
        service="backend-ai",
        release_sha=self.audit_release_sha,
        event_id=sha256(identity.encode()).hexdigest()[:32],
        request_id=sha256(command.idempotency_key.encode()).hexdigest()[:32],
        action=action,
        outcome=outcome,
        tenant_id=command.scope.tenant_id,
        actor_id=command.scope.user_id,
        resource_id=command.memory_id,
      )
    )

  def _audited_change(self, command, action: AuditAction, operation):
    self._audit(command, action, AuditOutcome.ATTEMPT)
    try:
      result = operation()
    except Exception:
      self._audit(command, action, AuditOutcome.ERROR)
      raise
    self._audit(command, action, AuditOutcome.SUCCESS)
    return result

  def _confirm(
    self,
    receipt: ConsentReceipt,
    *,
    action: MemoryAction,
    scope: MemoryScope,
    memory_id: str,
    content: str,
    **bound_fields,
  ) -> None:
    expected = intent_checksum(action, scope, memory_id, content, **bound_fields)
    now = self.clock.now()
    checks = [
      receipt.actor_user_id == scope.user_id,
      receipt.action == action,
      receipt.intent_checksum == expected,
      receipt.confirmed_at <= now,
      receipt.expires_at > now,
      self.policy is None or receipt.policy_version == self.policy.policy_version,
      self.confirmation_verifier.verify(receipt),
    ]
    if not all(checks):
      raise MemoryPolicyError("explicit confirmation is invalid")
    if self.policy is not None:
      self.policy.validate_confirmation_window(receipt.confirmed_at, receipt.expires_at)

  def create(self, command: CreateConfirmedMemory) -> MemoryRecord:
    return self._audited_change(
      command,
      AuditAction.MEMORY_CHANGE,
      lambda: self._create(command),
    )

  def _create(self, command: CreateConfirmedMemory) -> MemoryRecord:
    self._confirm(
      command.receipt,
      action="create",
      scope=command.scope,
      memory_id=command.memory_id,
      content=command.content,
      memory_type=command.memory_type,
      conflict_key=command.conflict_key,
      source_event_id=command.source_event_id,
      provenance=command.provenance,
      confidence=command.confidence,
      salience=command.salience,
      retention_class=command.retention_class,
      expires_at=command.expires_at,
    )
    now = self.clock.now()
    if self.policy is not None:
      self.policy.validate_create(command, now)
    if command.expires_at <= now:
      raise MemoryPolicyError("memory expiry must be in the future")
    existing = self.repository.get(command.scope, command.memory_id)
    if existing:
      if existing.content == command.content and existing.consent.confirmation_id == command.receipt.confirmation_id:
        return existing
      raise MemoryConflict("memory already exists")
    if any(
      record.status is MemoryStatus.ACTIVE
      and record.conflict_key == command.conflict_key
      for record in self.repository.list(command.scope)
    ):
      raise MemoryConflict("active memory conflict requires explicit supersession")
    record = MemoryRecord(
      memory_id=command.memory_id,
      scope=command.scope,
      memory_type=command.memory_type,
      conflict_key=command.conflict_key,
      content=command.content,
      source_event_id=command.source_event_id,
      provenance=command.provenance,
      confidence=command.confidence,
      salience=command.salience,
      retention_class=command.retention_class,
      created_at=now,
      updated_at=now,
      expires_at=command.expires_at,
      checksum=content_checksum(command.content),
      status=MemoryStatus.ACTIVE,
      consent=command.receipt,
    )
    return self.repository.save(record, command.idempotency_key)

  def get(self, scope: MemoryScope, memory_id: str) -> MemoryRecord:
    record = self.repository.get(scope, memory_id)
    if record is None:
      raise MemoryPolicyError("memory is unavailable in this scope")
    return record

  @staticmethod
  def _is_supersede_replay(current, replacement, command) -> bool:
    checks = [
      current.status is MemoryStatus.SUPERSEDED,
      current.superseded_by_id == command.replacement_id,
      replacement is not None,
      replacement is not None and replacement.status is MemoryStatus.ACTIVE,
      replacement is not None and replacement.supersedes_id == current.memory_id,
      replacement is not None and replacement.content == command.content,
      replacement is not None and replacement.consent == command.receipt,
    ]
    return all(checks)

  def supersede(self, command: SupersedeMemory) -> MemoryRecord:
    return self._audited_change(
      command,
      AuditAction.MEMORY_CHANGE,
      lambda: self._supersede(command),
    )

  def _supersede(self, command: SupersedeMemory) -> MemoryRecord:
    self._confirm(
      command.receipt,
      action="supersede",
      scope=command.scope,
      memory_id=command.memory_id,
      content=command.content,
      replacement_id=command.replacement_id,
    )
    current = self.get(command.scope, command.memory_id)
    if self.policy is not None:
      self.policy.validate_content(current.memory_type, command.content)
    existing_replacement = self.repository.get(command.scope, command.replacement_id)
    if self._is_supersede_replay(current, existing_replacement, command):
      return self.repository.supersede(current, existing_replacement, command.idempotency_key)
    if current.status is not MemoryStatus.ACTIVE:
      raise MemoryConflict("only an active memory can be superseded")
    if existing_replacement:
      raise MemoryConflict("replacement memory already exists")
    now = self.clock.now()
    previous = current.model_copy(
      update={"status": MemoryStatus.SUPERSEDED, "superseded_by_id": command.replacement_id, "updated_at": now}
    )
    replacement = current.model_copy(
      update={
        "memory_id": command.replacement_id,
        "content": command.content,
        "checksum": content_checksum(command.content),
        "created_at": now,
        "updated_at": now,
        "supersedes_id": current.memory_id,
        "superseded_by_id": None,
        "status": MemoryStatus.ACTIVE,
        "consent": command.receipt,
      }
    )
    return self.repository.supersede(previous, replacement, command.idempotency_key)

  def revoke(self, command: RevokeConsent) -> MemoryRecord:
    return self._audited_change(
      command,
      AuditAction.CONSENT_CHANGE,
      lambda: self._transition(command, action="revoke", status=MemoryStatus.CONSENT_REVOKED),
    )

  def delete(self, command: DeleteMemory) -> MemoryRecord:
    return self._audited_change(
      command,
      AuditAction.MEMORY_CHANGE,
      lambda: self._transition(command, action="delete", status=MemoryStatus.DELETED),
    )

  def _transition(self, command, *, action: MemoryAction, status: MemoryStatus) -> MemoryRecord:
    self._confirm(command.receipt, action=action, scope=command.scope, memory_id=command.memory_id, content="")
    current = self.get(command.scope, command.memory_id)
    if current.status is status and current.consent == command.receipt:
      return self.repository.save(current, command.idempotency_key)
    if current.status is MemoryStatus.DELETED:
      raise MemoryConflict("deleted memory cannot transition")
    updates = {"status": status, "updated_at": self.clock.now(), "consent": command.receipt}
    if status is MemoryStatus.DELETED:
      updates.update({"content": "[deleted]", "checksum": content_checksum("[deleted]")})
    changed = current.model_copy(update=updates)
    return self.repository.save(changed, command.idempotency_key)

  def export(self, scope: MemoryScope) -> list[MemoryRecord]:
    return list(self.repository.list(scope))

  def search(self, scope: MemoryScope, text: str, *, limit: int = 10) -> list[RevalidatedMemoryCandidate]:
    if self.candidate_index is None:
      return []
    now = self.clock.now()
    result_limit = max(1, min(int(limit), 20))
    candidate_limit = min(max(result_limit * 10, 50), 200)
    results = []
    accepted_ids = set()
    accepted_conflict_keys: dict[str, str] = {}
    for candidate in self.candidate_index.search_ids(scope, text, candidate_limit):
      if candidate.memory_id in accepted_ids:
        continue
      record = self.repository.get(scope, candidate.memory_id)
      if (
        record is None
        or record.scope != scope
        or record.status is not MemoryStatus.ACTIVE
        or record.expires_at <= now
        or record.checksum != candidate.checksum
      ):
        continue
      conflict_memory_id = accepted_conflict_keys.get(record.conflict_key)
      if conflict_memory_id is not None and conflict_memory_id != record.memory_id:
        raise MemoryConflict("active memory conflict requires explicit resolution")
      accepted_ids.add(record.memory_id)
      accepted_conflict_keys[record.conflict_key] = record.memory_id
      age_days = max(0.0, (now - record.updated_at).total_seconds() / 86_400)
      recency = 1 / (1 + age_days)
      ranking_score = (
        0.7 * candidate.score
        + 0.15 * record.salience
        + 0.1 * record.confidence
        + 0.05 * recency
      )
      results.append(
        RevalidatedMemoryCandidate(
          memory=record,
          score=ranking_score,
          projection_version=candidate.projection_version,
        )
      )
    return sorted(
      results,
      key=lambda item: (-item.score, item.memory.memory_id),
    )[:result_limit]
