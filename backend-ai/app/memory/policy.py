from __future__ import annotations

from datetime import datetime
from hashlib import sha256
import json
from pathlib import Path
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .commands import CreateConfirmedMemory


class MemoryPolicyViolation(ValueError):
  """A consent, content or retention rule rejected a memory mutation."""


class StrictPolicyModel(BaseModel):
  model_config = ConfigDict(extra="forbid")


class ConsentPolicy(StrictPolicyModel):
  explicit_confirmation_required_for: list[str]
  confirmation_ttl_seconds: int = Field(..., gt=0, le=3600)
  intent_bound_fields: dict[str, list[str]]
  silent_inference: bool
  silent_conflict_resolution: bool


class IdentityPolicy(StrictPolicyModel):
  scope: list[str]
  cross_tenant_access: bool
  cross_user_access: bool
  scope_from_request_body: bool


class ContentPolicy(StrictPolicyModel):
  allowed_memory_types: list[str] = Field(..., min_length=1)
  maximum_characters: int = Field(..., gt=0, le=8000)
  forbidden_memory_types: list[str]
  secrets: str
  prompt_injection: str


class RetentionRule(StrictPolicyModel):
  maximum_seconds: int = Field(..., gt=0)


class LifecyclePolicy(StrictPolicyModel):
  export_required: bool
  delete_sla_hours: int = Field(..., gt=0, le=24)
  expired_status_is_retrievable: bool
  revoked_status_is_retrievable: bool
  deleted_body: Literal["physically_remove_from_projection_and_redact_canonical_body"]
  supersession: Literal["surface_conflicts_and_require_new_confirmation"]


class ProjectionPolicy(StrictPolicyModel):
  canonical_store: str
  qdrant_collection_prefix: str
  separate_from_knowledge_collection: bool
  qdrant_payload_fields: list[str]
  qdrant_raw_content_payload: bool
  mongo_revalidation_required: bool
  physical_delete_on_revoke_delete_expiry: bool


class PromptBudgetPolicy(StrictPolicyModel):
  maximum_memories: int = Field(..., gt=0, le=20)
  maximum_characters: int = Field(..., gt=0, le=8000)
  separate_from_knowledge_context: bool
  render_as_untrusted_user_data: bool


class RolloutPolicy(StrictPolicyModel):
  write_enabled: bool
  retrieval_enabled: bool
  response_enabled: bool
  shadow_before_response: bool
  deployment_authorized: bool
  publication_authorized: bool


class MemoryPolicy(StrictPolicyModel):
  policy_version: str
  approved_at: str
  review_by: str
  approval_evidence: str
  identity: IdentityPolicy
  consent: ConsentPolicy
  content: ContentPolicy
  retention_classes: dict[str, RetentionRule]
  lifecycle: LifecyclePolicy
  projection: ProjectionPolicy
  prompt_budget: PromptBudgetPolicy
  rollout: RolloutPolicy

  @model_validator(mode="after")
  def validate_fail_closed_contract(self):
    if set(self.consent.explicit_confirmation_required_for) != {
      "create", "supersede", "revoke", "delete"
    }:
      raise ValueError("every memory mutation must require confirmation")
    if self.consent.silent_inference or self.consent.silent_conflict_resolution:
      raise ValueError("silent memory inference or conflict resolution is forbidden")
    if (
      set(self.identity.scope) != {"tenant_id", "user_id"}
      or self.identity.cross_tenant_access
      or self.identity.cross_user_access
      or self.identity.scope_from_request_body
    ):
      raise ValueError("memory identity must be server-derived tenant and user scope")
    expected_intent_fields = {
      "create": {
        "action", "tenant_id", "user_id", "memory_id", "content", "memory_type",
        "conflict_key", "source_event_id", "provenance", "confidence", "salience",
        "retention_class", "expires_at",
      },
      "supersede": {
        "action", "tenant_id", "user_id", "memory_id", "content", "replacement_id",
      },
      "revoke": {"action", "tenant_id", "user_id", "memory_id", "content"},
      "delete": {"action", "tenant_id", "user_id", "memory_id", "content"},
    }
    if {
      action: set(fields)
      for action, fields in self.consent.intent_bound_fields.items()
    } != expected_intent_fields:
      raise ValueError("memory confirmation intent fields must match the enforced checksum")
    if (
      not self.projection.separate_from_knowledge_collection
      or self.projection.qdrant_raw_content_payload
      or not self.projection.mongo_revalidation_required
      or not self.projection.physical_delete_on_revoke_delete_expiry
    ):
      raise ValueError("memory projection must remain private, separate and rebuildable")
    if set(self.projection.qdrant_payload_fields) != {
      "memory_id", "tenant_id", "user_id", "memory_type", "checksum",
      "projection_version", "expires_at", "status"
    }:
      raise ValueError("memory projection payload fields must match the content-free contract")
    if (
      not self.lifecycle.export_required
      or self.lifecycle.expired_status_is_retrievable
      or self.lifecycle.revoked_status_is_retrievable
    ):
      raise ValueError("memory lifecycle must preserve export and fail-closed retrieval")
    if (
      not self.prompt_budget.separate_from_knowledge_context
      or not self.prompt_budget.render_as_untrusted_user_data
    ):
      raise ValueError("memory prompt data must remain separate and explicitly untrusted")
    if self.rollout.response_enabled and not self.rollout.retrieval_enabled:
      raise ValueError("memory response augmentation requires retrieval")
    if self.rollout.retrieval_enabled and not self.rollout.write_enabled:
      raise ValueError("memory retrieval requires the governed canonical lifecycle")
    if (
      (self.rollout.write_enabled or self.rollout.retrieval_enabled or self.rollout.response_enabled)
      and not self.rollout.deployment_authorized
    ):
      raise ValueError("memory rollout cannot be enabled without deployment authorization")
    return self

  @classmethod
  def load(cls, path: Path) -> "MemoryPolicy":
    return cls.model_validate_json(path.read_bytes())

  def validate_confirmation_window(self, confirmed_at: datetime, expires_at: datetime) -> None:
    if (expires_at - confirmed_at).total_seconds() > self.consent.confirmation_ttl_seconds:
      raise MemoryPolicyViolation("confirmation exceeds the approved TTL")

  def validate_create(self, command: CreateConfirmedMemory, now: datetime) -> None:
    self.validate_content(command.memory_type, command.content)
    rule = self.retention_classes.get(command.retention_class)
    if rule is None:
      raise MemoryPolicyViolation("retention class is not approved")
    if (command.expires_at - now).total_seconds() > rule.maximum_seconds:
      raise MemoryPolicyViolation("memory retention exceeds its approved class")

  def validate_content(self, memory_type: str, content: str) -> None:
    if memory_type not in self.content.allowed_memory_types:
      raise MemoryPolicyViolation("memory type is not approved")
    if len(content) > self.content.maximum_characters:
      raise MemoryPolicyViolation("memory content exceeds the approved limit")
    if _SECRET_PATTERN.search(content):
      raise MemoryPolicyViolation("memory contains a secret-like value")


_SECRET_PATTERN = re.compile(
  r"(?i)(?:-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|"
  r"\b(?:api[_-]?key|access[_-]?token|password|passwd|pwd)\b\s*(?:=|:)\s*\S{8,}|"
  r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|"
  r"\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b)"
)


def canonical_policy_sha256(path: Path) -> str:
  parsed = json.loads(path.read_text(encoding="utf-8"))
  canonical = json.dumps(parsed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
  return sha256(canonical.encode("utf-8")).hexdigest()
