from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from hashlib import sha256
import hmac
import json
from pathlib import Path
import re
import sqlite3
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, field_validator, model_validator


WEBHOOK_SIGNATURE_VERSION = "v1"
WEBHOOK_INGRESS_METHOD = "POST"
WEBHOOK_INGRESS_PATH = "/webhook/eisenhower-rag-ingestion"
WEBHOOK_REPLAY_RETENTION_SECONDS = 24 * 60 * 60
RFC3339_TIMESTAMP = re.compile(
  r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


BoundedIdentifier = Annotated[StrictStr, Field(min_length=1, max_length=128)]


class StrictWebhookModel(BaseModel):
  model_config = ConfigDict(extra="forbid")


class WebhookAcl(StrictWebhookModel):
  owner_id: BoundedIdentifier
  reader_ids: list[BoundedIdentifier] = Field(default_factory=list, max_length=1000)

  @field_validator("reader_ids")
  @classmethod
  def readers_must_be_unique(cls, value: list[str]) -> list[str]:
    if len(value) != len(set(value)):
      raise ValueError("reader_ids must be unique")
    return value


class WebhookDocument(StrictWebhookModel):
  document_id: Annotated[StrictStr, Field(min_length=1, max_length=256)]
  source_type: Literal["task", "project", "note", "runbook", "calendar_event"]
  title: Annotated[StrictStr, Field(max_length=1000)]
  content: Annotated[StrictStr, Field(max_length=1_000_000)]
  source_uri: Annotated[StrictStr, Field(max_length=2048)] | None = None
  updated_at: StrictStr | None = None
  acl: WebhookAcl

  @model_validator(mode="before")
  @classmethod
  def optional_fields_cannot_be_null(cls, value):
    if isinstance(value, dict):
      for name in ("source_uri", "updated_at"):
        if name in value and value[name] is None:
          raise ValueError(f"{name} cannot be null")
    return value

  @field_validator("updated_at")
  @classmethod
  def updated_at_must_be_rfc3339(cls, value: str | None) -> str | None:
    if value is None:
      return None
    if RFC3339_TIMESTAMP.fullmatch(value) is None:
      raise ValueError("updated_at must use RFC 3339 date-time syntax")
    candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(candidate)
    if parsed.tzinfo is None:
      raise ValueError("updated_at must include a timezone")
    return value


class WebhookEnvelope(StrictWebhookModel):
  schema_version: Literal["2"]
  event_id: UUID
  operation: Literal["upsert", "tombstone", "reindex_project", "start_rag_evaluation"]
  tenant_id: BoundedIdentifier
  project_id: BoundedIdentifier
  source_version: BoundedIdentifier
  source_sequence: StrictInt = Field(..., ge=0, le=9_223_372_036_854_775_807)
  content_checksum: StrictStr = Field(..., pattern=r"^sha256:[a-f0-9]{64}$")
  embedding_version: BoundedIdentifier
  chunking_version: BoundedIdentifier
  dataset_version: BoundedIdentifier | None = None
  documents: list[WebhookDocument] | None = Field(default=None, min_length=1, max_length=500)
  document_ids: list[Annotated[StrictStr, Field(min_length=1, max_length=256)]] | None = Field(
    default=None,
    min_length=1,
    max_length=5000,
  )

  @model_validator(mode="before")
  @classmethod
  def optional_fields_cannot_be_null(cls, value):
    if isinstance(value, dict):
      for name in ("dataset_version", "documents", "document_ids"):
        if name in value and value[name] is None:
          raise ValueError(f"{name} cannot be null")
    return value

  @model_validator(mode="after")
  def operation_payload_is_complete(self):
    optional_presence = {
      "dataset_version": self.dataset_version is not None,
      "documents": self.documents is not None,
      "document_ids": self.document_ids is not None,
    }
    expected_presence = {
      "upsert": {"dataset_version": False, "documents": True, "document_ids": False},
      "tombstone": {"dataset_version": False, "documents": False, "document_ids": True},
      "reindex_project": {
        "dataset_version": False,
        "documents": False,
        "document_ids": False,
      },
      "start_rag_evaluation": {
        "dataset_version": True,
        "documents": False,
        "document_ids": False,
      },
    }
    if optional_presence != expected_presence[self.operation]:
      raise ValueError(f"payload fields do not match operation {self.operation}")
    if self.document_ids is not None and len(self.document_ids) != len(set(self.document_ids)):
      raise ValueError("document_ids must be unique")
    return self


def parse_webhook_envelope(raw_body: bytes) -> WebhookEnvelope:
  def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
      if key in result:
        raise ValueError(f"Duplicate JSON field: {key}")
      result[key] = value
    return result

  def reject_non_finite(value: str):
    raise ValueError(f"Non-finite JSON number is forbidden: {value}")

  decoded = raw_body.decode("utf-8")
  payload = json.loads(
    decoded,
    object_pairs_hook=reject_duplicate_keys,
    parse_constant=reject_non_finite,
  )
  if not isinstance(payload, dict):
    raise ValueError("Webhook body must be a JSON object")
  return WebhookEnvelope.model_validate(payload)


class WebhookReplayVerifier:
  def __init__(
    self,
    path: Path,
    *,
    secret: str,
    window_seconds: int = 300,
    replay_retention_seconds: int = WEBHOOK_REPLAY_RETENTION_SECONDS,
    clock: Callable[[], int] | None = None,
  ):
    if not secret:
      raise ValueError("Webhook signing secret is required")
    if replay_retention_seconds <= window_seconds:
      raise ValueError("Replay retention must exceed the signature window")
    self.path = path
    self.secret = secret.encode("utf-8")
    self.window_seconds = window_seconds
    self.replay_retention_seconds = replay_retention_seconds
    self.clock = clock or (lambda: int(datetime.now(timezone.utc).timestamp()))
    self.path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(self.path) as connection:
      connection.execute(
        "CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, accepted_at INTEGER NOT NULL)"
      )

  @staticmethod
  def signature_message(
    timestamp: str,
    raw_body: bytes,
    *,
    method: str = WEBHOOK_INGRESS_METHOD,
    path: str = WEBHOOK_INGRESS_PATH,
    version: str = WEBHOOK_SIGNATURE_VERSION,
  ) -> bytes:
    return b"\n".join(
      (
        version.encode("ascii"),
        timestamp.encode("ascii"),
        method.encode("ascii"),
        path.encode("ascii"),
        raw_body,
      )
    )

  def sign_webhook(
    self,
    timestamp: str,
    raw_body: bytes,
    *,
    method: str = WEBHOOK_INGRESS_METHOD,
    path: str = WEBHOOK_INGRESS_PATH,
    version: str = WEBHOOK_SIGNATURE_VERSION,
  ) -> str:
    message = self.signature_message(
      timestamp,
      raw_body,
      method=method,
      path=path,
      version=version,
    )
    return hmac.new(self.secret, message, sha256).hexdigest()

  def verify(
    self,
    timestamp: str,
    signature: str,
    event_id: str,
    raw_body: bytes,
    *,
    method: str,
    path: str,
    version: str,
  ) -> bool:
    if not self.verify_signature(
      timestamp,
      signature,
      raw_body,
      method=method,
      path=path,
      version=version,
    ):
      return False
    return self.reserve_event(event_id)

  def verify_signature(
    self,
    timestamp: str,
    signature: str,
    raw_body: bytes,
    *,
    method: str,
    path: str,
    version: str,
  ) -> bool:
    if (
      version != WEBHOOK_SIGNATURE_VERSION
      or method != WEBHOOK_INGRESS_METHOD
      or path != WEBHOOK_INGRESS_PATH
      or not timestamp.isascii()
      or not timestamp.isdigit()
      or not 1 <= len(timestamp) <= 16
      or re.fullmatch(r"[a-f0-9]{64}", signature) is None
    ):
      return False
    received_at = int(timestamp)
    now = self.clock()
    if abs(now - received_at) > self.window_seconds:
      return False
    expected = self.sign_webhook(
      timestamp,
      raw_body,
      method=method,
      path=path,
      version=version,
    )
    if not hmac.compare_digest(signature, expected):
      return False
    return True

  def reserve_event(self, event_id: str) -> bool:
    now = self.clock()
    try:
      with sqlite3.connect(self.path, timeout=5) as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
          "DELETE FROM webhook_events WHERE accepted_at < ?",
          (now - self.replay_retention_seconds,),
        )
        connection.execute(
          "INSERT INTO webhook_events (event_id, accepted_at) VALUES (?, ?)",
          (event_id, now),
        )
      return True
    except sqlite3.IntegrityError:
      return False

  def sign_internal_dispatch(self, event_id: str, tenant_id: str, operation: str) -> str:
    message = f"{event_id}|{tenant_id}|{operation}".encode("utf-8")
    return hmac.new(self.secret, message, sha256).hexdigest()

  def verify_internal_dispatch(
    self,
    signature: str,
    event_id: str,
    tenant_id: str,
    operation: str,
  ) -> bool:
    expected = self.sign_internal_dispatch(event_id, tenant_id, operation)
    return hmac.compare_digest(signature, expected)
