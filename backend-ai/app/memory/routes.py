from __future__ import annotations

from datetime import datetime, timedelta
from hashlib import sha256
import logging
import re
import time
from typing import Annotated, Literal

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import Field, model_validator

from .adapters import MemoryPersistenceUnavailable
from .application import MemoryConflict, MemoryPolicyError
from .commands import CreateConfirmedMemory, DeleteMemory, RevokeConsent, SupersedeMemory
from .models import ConsentReceipt, MemoryScope, StrictModel, intent_checksum
from .policy import MemoryPolicyViolation
from .runtime import MemoryRuntime


class CreateIntent(StrictModel):
  action: Literal["create"]
  memory_id: str = Field(..., min_length=1, max_length=128)
  memory_type: str = Field(..., min_length=1, max_length=64)
  conflict_key: str = Field(..., min_length=1, max_length=128)
  content: str = Field(..., min_length=1, max_length=8000)
  source_event_id: str = Field(..., min_length=1, max_length=128)
  provenance: str = Field(..., min_length=1, max_length=500)
  confidence: float = Field(..., ge=0, le=1)
  salience: float = Field(..., ge=0, le=1)
  retention_class: str = Field(..., min_length=1, max_length=64)
  expires_at: datetime

  @model_validator(mode="after")
  def expiry_is_timezone_aware(self):
    if self.expires_at.tzinfo is None or self.expires_at.utcoffset() is None:
      raise ValueError("memory expiry must be timezone-aware")
    return self


class SupersedeIntent(StrictModel):
  action: Literal["supersede"]
  memory_id: str = Field(..., min_length=1, max_length=128)
  replacement_id: str = Field(..., min_length=1, max_length=128)
  content: str = Field(..., min_length=1, max_length=8000)


class RevokeIntent(StrictModel):
  action: Literal["revoke"]
  memory_id: str = Field(..., min_length=1, max_length=128)


class DeleteIntent(StrictModel):
  action: Literal["delete"]
  memory_id: str = Field(..., min_length=1, max_length=128)


MemoryIntent = Annotated[
  CreateIntent | SupersedeIntent | RevokeIntent | DeleteIntent,
  Field(discriminator="action"),
]


class ConfirmMemoryRequest(StrictModel):
  intent: MemoryIntent
  receipt: ConsentReceipt


class PrepareMemoryResponse(StrictModel):
  action: str
  memory_id: str
  receipt: ConsentReceipt


class ConfirmMemoryResponse(StrictModel):
  memory_id: str
  status: str
  projection_state: Literal["synchronized", "pending", "not_configured"]


class MemoryExportItem(StrictModel):
  memory_id: str
  memory_type: str
  conflict_key: str
  content: str
  provenance: str
  confidence: float
  salience: float
  retention_class: str
  created_at: datetime
  updated_at: datetime
  expires_at: datetime
  status: str
  supersedes_id: str | None
  superseded_by_id: str | None
  consent_action: str
  consent_policy_version: str
  consented_at: datetime


class MemoryExportResponse(StrictModel):
  items: list[MemoryExportItem]


class RetrievalShadowRequest(StrictModel):
  query: str = Field(..., min_length=1, max_length=2000)
  limit: int = Field(default=3, ge=1, le=20)


class RetrievalShadowResponse(StrictModel):
  mode: Literal["shadow"] = "shadow"
  hit_count: int = Field(..., ge=0)
  response_augmented: Literal[False] = False


_IDEMPOTENCY_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_LOGGER = logging.getLogger("uvicorn.error")


def create_memory_router(
  runtime: MemoryRuntime,
  *,
  write_enabled: bool,
  retrieval_enabled: bool,
  metrics=None,
) -> APIRouter:
  router = APIRouter(prefix="/v2/memory", tags=["memory"])

  if write_enabled:
    @router.post("/prepare", response_model=PrepareMemoryResponse)
    def prepare_memory(intent: MemoryIntent, request: Request):
      _require_scope(request, "memory:write")
      scope = _memory_scope(request)
      now = runtime.clock.now()
      try:
        bound = _bound_fields(intent, runtime, scope, now)
      except (MemoryPolicyError, MemoryPolicyViolation) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
      except MemoryPersistenceUnavailable as error:
        raise HTTPException(status_code=503, detail="Memory persistence is unavailable.") from error
      unsigned = ConsentReceipt(
        confirmation_id="pending",
        actor_user_id=scope.user_id,
        action=intent.action,
        intent_checksum=intent_checksum(
          intent.action,
          scope,
          intent.memory_id,
          getattr(intent, "content", ""),
          **bound,
        ),
        policy_version=runtime.policy.policy_version,
        confirmed_at=now,
        expires_at=now + timedelta(
          seconds=runtime.policy.consent.confirmation_ttl_seconds
        ),
      )
      receipt = runtime.confirmation_signer.sign(unsigned, key_id=_signing_key_id(runtime))
      return PrepareMemoryResponse(
        action=intent.action,
        memory_id=intent.memory_id,
        receipt=receipt,
      )

    @router.post("/confirm", response_model=ConfirmMemoryResponse)
    def confirm_memory(
      payload: ConfirmMemoryRequest,
      request: Request,
      idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ):
      _require_scope(request, "memory:write")
      if not _IDEMPOTENCY_PATTERN.fullmatch(idempotency_key):
        raise HTTPException(status_code=400, detail="A valid Idempotency-Key is required.")
      started = time.perf_counter()
      scope = _memory_scope(request)
      try:
        record = _execute(
          runtime,
          scope,
          payload,
          _scoped_idempotency_key(scope, idempotency_key),
        )
      except MemoryPolicyError as error:
        _observe(metrics, payload.intent.action, "rejected", started)
        raise HTTPException(
          status_code=403,
          detail="Explicit memory confirmation is invalid.",
        ) from error
      except MemoryPolicyViolation as error:
        _observe(metrics, payload.intent.action, "rejected", started)
        raise HTTPException(status_code=422, detail=str(error)) from error
      except MemoryConflict as error:
        _observe(metrics, payload.intent.action, "conflict", started)
        raise HTTPException(status_code=409, detail=str(error)) from error
      except MemoryPersistenceUnavailable as error:
        _observe(metrics, payload.intent.action, "error", started)
        raise HTTPException(status_code=503, detail="Memory persistence is unavailable.") from error
      except Exception:
        _observe(metrics, payload.intent.action, "error", started)
        raise
      projection_state = _reconcile(runtime, record.scope)
      _observe(metrics, payload.intent.action, "success", started)
      return ConfirmMemoryResponse(
        memory_id=record.memory_id,
        status=record.status.value,
        projection_state=projection_state,
      )

    @router.get("/export", response_model=MemoryExportResponse)
    def export_memory(request: Request):
      _require_scope(request, "memory:read")
      started = time.perf_counter()
      try:
        records = runtime.application.export(_memory_scope(request))
      except MemoryPersistenceUnavailable as error:
        _observe(metrics, "export", "error", started)
        raise HTTPException(status_code=503, detail="Memory persistence is unavailable.") from error
      _observe(metrics, "export", "success", started)
      return MemoryExportResponse(items=[_export_item(record) for record in records])

  if retrieval_enabled:
    @router.post("/retrieval-shadow", response_model=RetrievalShadowResponse)
    def retrieval_shadow(payload: RetrievalShadowRequest, request: Request):
      _require_scope(request, "memory:read")
      started = time.perf_counter()
      try:
        results = runtime.application.search(
          _memory_scope(request), payload.query, limit=payload.limit
        )
      except Exception as error:
        _observe(metrics, "search", "error", started)
        raise HTTPException(status_code=503, detail="Memory retrieval is unavailable.") from error
      _observe(metrics, "search", "success" if results else "no_hit", started)
      return RetrievalShadowResponse(hit_count=len(results))

  return router


def _memory_scope(request: Request) -> MemoryScope:
  principal = request.state.principal
  return MemoryScope(tenant_id=principal.tenant_id, user_id=principal.user_id)


def _scoped_idempotency_key(scope: MemoryScope, client_key: str) -> str:
  material = f"{scope.tenant_id}\0{scope.user_id}\0{client_key}".encode("utf-8")
  return sha256(material).hexdigest()


def _require_scope(request: Request, required: str) -> None:
  scopes = set(request.state.principal.scopes)
  if "*" not in scopes and required not in scopes:
    raise HTTPException(status_code=403, detail=f"Missing {required} scope.")


def _bound_fields(intent, runtime, scope, now) -> dict:
  if intent.action == "create":
    runtime.policy.validate_content(intent.memory_type, intent.content)
    retention = runtime.policy.retention_classes.get(intent.retention_class)
    if retention is None:
      raise MemoryPolicyViolation("retention class is not approved")
    if intent.expires_at <= now:
      raise MemoryPolicyViolation("memory expiry must be in the future")
    if (intent.expires_at - now).total_seconds() > retention.maximum_seconds:
      raise MemoryPolicyViolation("memory retention exceeds its approved class")
    return {
      "memory_type": intent.memory_type,
      "conflict_key": intent.conflict_key,
      "source_event_id": intent.source_event_id,
      "provenance": intent.provenance,
      "confidence": intent.confidence,
      "salience": intent.salience,
      "retention_class": intent.retention_class,
      "expires_at": intent.expires_at,
    }
  if intent.action == "supersede":
    current = runtime.application.get(scope, intent.memory_id)
    runtime.policy.validate_content(current.memory_type, intent.content)
    return {"replacement_id": intent.replacement_id}
  runtime.application.get(scope, intent.memory_id)
  return {}


def _execute(runtime, scope, payload, idempotency_key):
  intent = payload.intent
  common = {
    "scope": scope,
    "memory_id": intent.memory_id,
    "receipt": payload.receipt,
    "idempotency_key": idempotency_key,
  }
  if intent.action == "create":
    return runtime.application.create(CreateConfirmedMemory(
      **common,
      memory_type=intent.memory_type,
      conflict_key=intent.conflict_key,
      content=intent.content,
      source_event_id=intent.source_event_id,
      provenance=intent.provenance,
      confidence=intent.confidence,
      salience=intent.salience,
      retention_class=intent.retention_class,
      expires_at=intent.expires_at,
    ))
  if intent.action == "supersede":
    return runtime.application.supersede(SupersedeMemory(
      **common,
      replacement_id=intent.replacement_id,
      content=intent.content,
    ))
  if intent.action == "revoke":
    return runtime.application.revoke(RevokeConsent(**common))
  return runtime.application.delete(DeleteMemory(**common))


def _reconcile(runtime, scope) -> str:
  if runtime.reconciler is None:
    return "not_configured"
  try:
    runtime.reconciler.reconcile(scope)
    return "synchronized"
  except Exception:
    # Canonical Mongo commit has already succeeded. Retrieval still revalidates
    # every candidate against Mongo, so projection repair can safely retry.
    _LOGGER.warning("Memory projection reconciliation is pending", exc_info=True)
    return "pending"


def _signing_key_id(runtime) -> str:
  return next(iter(runtime.confirmation_signer.keys))


def _export_item(record) -> MemoryExportItem:
  return MemoryExportItem(
    memory_id=record.memory_id,
    memory_type=record.memory_type,
    conflict_key=record.conflict_key,
    content=record.content,
    provenance=record.provenance,
    confidence=record.confidence,
    salience=record.salience,
    retention_class=record.retention_class,
    created_at=record.created_at,
    updated_at=record.updated_at,
    expires_at=record.expires_at,
    status=record.status.value,
    supersedes_id=record.supersedes_id,
    superseded_by_id=record.superseded_by_id,
    consent_action=record.consent.action,
    consent_policy_version=record.consent.policy_version,
    consented_at=record.consent.confirmed_at,
  )


def _observe(metrics, operation: str, outcome: str, started: float) -> None:
  if metrics is not None:
    metrics.observe_memory(
      operation,
      outcome,
      duration_seconds=time.perf_counter() - started,
    )
