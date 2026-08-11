from __future__ import annotations

from datetime import datetime
from enum import Enum
from hashlib import sha256
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
  model_config = ConfigDict(extra="forbid")


class MemoryStatus(str, Enum):
  ACTIVE = "active"
  SUPERSEDED = "superseded"
  CONSENT_REVOKED = "consent_revoked"
  DELETED = "deleted"


MemoryAction = Literal["create", "supersede", "revoke", "delete"]


def _is_utc(value: datetime) -> bool:
  return value.tzinfo is not None and value.utcoffset() is not None


def content_checksum(content: str) -> str:
  return sha256(content.encode("utf-8")).hexdigest()


class MemoryScope(StrictModel):
  tenant_id: str = Field(..., min_length=1, max_length=128)
  user_id: str = Field(..., min_length=1, max_length=128)


def intent_checksum(
  action: MemoryAction,
  scope: MemoryScope,
  memory_id: str,
  content: str,
  **bound_fields,
) -> str:
  payload = {
    "action": action,
    "tenant_id": scope.tenant_id,
    "user_id": scope.user_id,
    "memory_id": memory_id,
    "content": content,
    **{key: _canonical_intent_value(value) for key, value in bound_fields.items()},
  }
  serialized = json.dumps(
    payload,
    sort_keys=True,
    separators=(",", ":"),
    ensure_ascii=False,
  )
  return sha256(serialized.encode("utf-8")).hexdigest()


def _canonical_intent_value(value):
  if isinstance(value, datetime):
    return value.isoformat()
  if isinstance(value, float) and value.is_integer():
    return int(value)
  if isinstance(value, (str, int, float, bool)) or value is None:
    return value
  if isinstance(value, list):
    return [_canonical_intent_value(item) for item in value]
  if isinstance(value, dict):
    return {str(key): _canonical_intent_value(item) for key, item in value.items()}
  raise TypeError(f"unsupported memory intent field type: {type(value).__name__}")


class ConsentReceipt(StrictModel):
  confirmation_id: str = Field(..., min_length=1, max_length=128)
  actor_user_id: str = Field(..., min_length=1, max_length=128)
  action: MemoryAction
  intent_checksum: str = Field(..., pattern=r"^[a-f0-9]{64}$")
  policy_version: str = Field(..., min_length=1, max_length=64)
  confirmed_at: datetime
  expires_at: datetime

  @model_validator(mode="after")
  def validate_window(self):
    if not _is_utc(self.confirmed_at) or not _is_utc(self.expires_at):
      raise ValueError("confirmation timestamps must be timezone-aware")
    if self.expires_at <= self.confirmed_at:
      raise ValueError("confirmation expiry must follow confirmation")
    return self


class MemoryRecord(StrictModel):
  memory_id: str = Field(..., min_length=1, max_length=128)
  scope: MemoryScope
  memory_type: str = Field(..., min_length=1, max_length=64)
  conflict_key: str = Field(..., min_length=1, max_length=128)
  content: str = Field(..., min_length=1, max_length=8000)
  source_event_id: str = Field(..., min_length=1, max_length=128)
  provenance: str = Field(..., min_length=1, max_length=500)
  confidence: float = Field(..., ge=0, le=1)
  salience: float = Field(..., ge=0, le=1)
  retention_class: str = Field(..., min_length=1, max_length=64)
  created_at: datetime
  updated_at: datetime
  expires_at: datetime
  checksum: str = Field(..., pattern=r"^[a-f0-9]{64}$")
  supersedes_id: str | None = None
  superseded_by_id: str | None = None
  status: MemoryStatus
  consent: ConsentReceipt

  @model_validator(mode="after")
  def validate_lifecycle(self):
    timestamps = (self.created_at, self.updated_at, self.expires_at)
    if not all(_is_utc(value) for value in timestamps):
      raise ValueError("memory timestamps must be timezone-aware")
    if self.updated_at < self.created_at or self.expires_at <= self.created_at:
      raise ValueError("invalid memory lifecycle timestamps")
    if self.checksum != content_checksum(self.content):
      raise ValueError("memory checksum does not match content")
    if self.consent.actor_user_id != self.scope.user_id:
      raise ValueError("consent actor must match memory user")
    return self


class ProjectionCandidate(StrictModel):
  memory_id: str
  score: float
  projection_version: str
  checksum: str = Field(..., pattern=r"^[a-f0-9]{64}$")


class RevalidatedMemoryCandidate(StrictModel):
  memory: MemoryRecord
  score: float
  projection_version: str
