from __future__ import annotations

from datetime import datetime

from pydantic import Field

from .models import ConsentReceipt, MemoryScope, StrictModel


class ConfirmedCommand(StrictModel):
  scope: MemoryScope
  memory_id: str = Field(..., min_length=1, max_length=128)
  receipt: ConsentReceipt
  idempotency_key: str = Field(..., min_length=1, max_length=128)


class CreateConfirmedMemory(ConfirmedCommand):
  memory_type: str = Field(..., min_length=1, max_length=64)
  conflict_key: str = Field(..., min_length=1, max_length=128)
  content: str = Field(..., min_length=1, max_length=8000)
  source_event_id: str = Field(..., min_length=1, max_length=128)
  provenance: str = Field(..., min_length=1, max_length=500)
  confidence: float = Field(..., ge=0, le=1)
  salience: float = Field(..., ge=0, le=1)
  retention_class: str = Field(..., min_length=1, max_length=64)
  expires_at: datetime


class SupersedeMemory(ConfirmedCommand):
  replacement_id: str = Field(..., min_length=1, max_length=128)
  content: str = Field(..., min_length=1, max_length=8000)


class RevokeConsent(ConfirmedCommand):
  pass


class DeleteMemory(ConfirmedCommand):
  pass
