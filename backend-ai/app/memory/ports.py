from __future__ import annotations

from datetime import datetime
from typing import Protocol

from .models import ConsentReceipt, MemoryRecord, MemoryScope, ProjectionCandidate


class MemoryRepository(Protocol):
  def save(self, record: MemoryRecord, idempotency_key: str) -> MemoryRecord: ...
  def supersede(
    self,
    previous: MemoryRecord,
    replacement: MemoryRecord,
    idempotency_key: str,
  ) -> MemoryRecord: ...
  def get(self, scope: MemoryScope, memory_id: str) -> MemoryRecord | None: ...
  def list(self, scope: MemoryScope) -> list[MemoryRecord]: ...


class ConfirmationVerifier(Protocol):
  def verify(self, receipt: ConsentReceipt) -> bool: ...


class MemoryCandidateIndex(Protocol):
  def search_ids(self, scope: MemoryScope, text: str, limit: int) -> list[ProjectionCandidate]: ...


class Clock(Protocol):
  def now(self) -> datetime: ...
