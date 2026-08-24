from __future__ import annotations

import logging
import re
import time
from hashlib import sha256
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ..audit import AuditAction, AuditEvent, AuditOutcome
from ..auth import AuthError
from ..security_controls import SlidingWindowRateLimiter
from .composition import AppDependencies
from .schemas import InternalExtractionJobRequest, InternalJobRequest


request_logger = logging.getLogger("uvicorn.error")
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SENSITIVE_ACTIONS = {
  "/add-example": AuditAction.ADMIN_OPERATION,
  "/retrain": AuditAction.ADMIN_OPERATION,
  "/learn-feedback": AuditAction.ADMIN_OPERATION,
  "/learn-ocr-feedback": AuditAction.ADMIN_OPERATION,
  "/training-data": AuditAction.ADMIN_OPERATION,
  "/internal/webhooks/n8n/verify": AuditAction.INGEST,
  "/internal/rag/ingestion/upsert": AuditAction.INGEST,
  "/internal/rag/ingestion/tombstone": AuditAction.INGEST,
  "/internal/rag/ingestion/extract": AuditAction.INGEST,
  "/internal/rag/reindex": AuditAction.REINDEX,
  "/internal/rag/evaluations": AuditAction.ADMIN_OPERATION,
  "/v2/memory/prepare": AuditAction.CONSENT_CHANGE,
  "/v2/memory/confirm": AuditAction.MEMORY_CHANGE,
  "/v2/memory/export": AuditAction.MEMORY_EXPORT,
}


def register_middleware(app: FastAPI, deps: AppDependencies) -> None:
  settings = deps.settings
  metrics = deps.metrics_registry
  audit = deps.audit_sink
  ai_rate_limiter = SlidingWindowRateLimiter(limit=30, window_seconds=60)
  app.state.http_dependencies = deps
  app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_allow_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"],
  )

  def record_audit(
    request: Request,
    action: AuditAction,
    outcome: AuditOutcome,
    *,
    principal=None,
  ) -> None:
    resolved_principal = principal or getattr(request.state, "principal", None)
    try:
      audit.record(
        AuditEvent(
          service="backend-ai",
          release_sha=settings.release_sha,
          event_id=uuid4().hex,
          request_id=request.state.request_id,
          action=action,
          outcome=outcome,
          tenant_id=(resolved_principal.tenant_id if resolved_principal else "unknown"),
          actor_id=(resolved_principal.user_id if resolved_principal else "anonymous"),
          resource_id=request.url.path,
        )
      )
    except Exception:
      metrics.observe_audit("error")
      raise
    metrics.observe_audit(outcome.value)

  @app.middleware("http")
  async def audit_sensitive_requests(request: Request, call_next):
    action = SENSITIVE_ACTIONS.get(request.url.path)
    if action is None and request.url.path.startswith("/providers/"):
      action = AuditAction.ADMIN_OPERATION
    if action is None or (
      request.method not in UNSAFE_METHODS
      and action is not AuditAction.MEMORY_EXPORT
    ):
      return await call_next(request)
    try:
      record_audit(request, action, AuditOutcome.ATTEMPT)
    except Exception:
      request_logger.error("Required security audit preflight failed", exc_info=True)
      return JSONResponse(status_code=503, content={"error": "Security audit is unavailable"})
    try:
      response = await call_next(request)
    except Exception:
      try:
        record_audit(request, action, AuditOutcome.ERROR)
      except Exception:
        request_logger.critical("Security audit result write failed", exc_info=True)
      raise
    outcome = AuditOutcome.SUCCESS if response.status_code < 400 else AuditOutcome.REJECTED
    try:
      record_audit(request, action, outcome)
    except Exception:
      request_logger.critical("Security audit result write failed", exc_info=True)
      return JSONResponse(status_code=503, content={"error": "Security audit is unavailable"})
    return response

  @app.middleware("http")
  async def authenticate_requests(request: Request, call_next):
    if request.url.path in {"/", "/metrics", "/health/live", "/health/ready"} or request.method == "OPTIONS":
      return await call_next(request)
    origin = request.headers.get("origin")
    if origin and request.method in UNSAFE_METHODS and origin not in settings.cors_allow_origins:
      try:
        record_audit(request, AuditAction.ACL_REJECTION, AuditOutcome.REJECTED)
      except Exception:
        return JSONResponse(status_code=503, content={"error": "Security audit is unavailable"})
      return JSONResponse(status_code=403, content={"error": "Untrusted browser origin"})
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
      try:
        record_audit(request, AuditAction.AUTH_REJECTION, AuditOutcome.REJECTED)
      except Exception:
        return JSONResponse(status_code=503, content={"error": "Security audit is unavailable"})
      return JSONResponse(
        status_code=401,
        content={"error": "Authentication required"},
        headers={"WWW-Authenticate": "Bearer"},
      )
    try:
      verifier = deps.internal_verifier if request.url.path.startswith("/internal/") else deps.token_verifier
      if verifier is None:
        raise AuthError("Internal API is disabled")
      request.state.principal = verifier.verify(token)
    except AuthError:
      try:
        record_audit(request, AuditAction.AUTH_REJECTION, AuditOutcome.REJECTED)
      except Exception:
        return JSONResponse(status_code=503, content={"error": "Security audit is unavailable"})
      return JSONResponse(
        status_code=401,
        content={"error": "Access denied"},
        headers={"WWW-Authenticate": "Bearer"},
      )
    principal = request.state.principal
    if request.url.path in {
      "/v2/ai/analyze",
      "/v2/knowledge/search",
      "/v2/knowledge/answer",
      "/v2/memory/retrieval-shadow",
    }:
      rate_key = f"{principal.tenant_id}:{principal.user_id}:{request.url.path}"
      if not ai_rate_limiter.allow(rate_key):
        return JSONResponse(
          status_code=429,
          content={"error": "Rate limit exceeded"},
          headers={"Retry-After": "60"},
        )
    response = await call_next(request)
    if request.url.path.startswith(("/v2/", "/internal/")):
      subject = sha256(
        f"{principal.tenant_id}:{principal.user_id}".encode("utf-8")
      ).hexdigest()[:16]
      request_logger.info(
        "audit path=%s method=%s status=%s subject=%s",
        request.url.path,
        request.method,
        response.status_code,
        subject,
      )
    return response

  @app.middleware("http")
  async def log_requests(request: Request, call_next):
    if request.url.path in {"/", "/metrics", "/health/live", "/health/ready"} or request.method == "OPTIONS":
      return await call_next(request)
    started_at = time.perf_counter()
    response = await call_next(request)
    duration_ms = int((time.perf_counter() - started_at) * 1000)
    route = request.scope.get("route")
    route_path = getattr(route, "path", request.url.path)
    metrics.observe_http(request.method, route_path, response.status_code, duration_ms / 1000)
    message = f"backend-ai {request.method} {request.url.path} {response.status_code} {duration_ms}ms"
    if response.status_code >= 500:
      request_logger.error(message)
    else:
      request_logger.info(message)
    return response

  @app.middleware("http")
  async def bind_request_id(request: Request, call_next):
    supplied = request.headers.get("x-request-id", "")
    request.state.request_id = supplied if REQUEST_ID_PATTERN.fullmatch(supplied) else uuid4().hex
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    return response


def require_internal_dispatch(
  request: Request,
  envelope: InternalJobRequest | InternalExtractionJobRequest,
  operation: str,
) -> None:
  deps: AppDependencies = request.app.state.http_dependencies
  principal = request.state.principal
  if "rag:ingest" not in principal.scopes or deps.webhook_verifier is None:
    raise HTTPException(status_code=403, detail="Internal ingestion is disabled.")
  if envelope.tenant_id not in deps.settings.internal_allowed_tenants:
    raise HTTPException(status_code=403, detail="Tenant is outside the connector scope.")
  signature = request.headers.get("x-eisenhower-signature", "")
  if not deps.webhook_verifier.verify_internal_dispatch(
    signature,
    envelope.event_id,
    envelope.tenant_id,
    operation,
  ):
    raise HTTPException(status_code=403, detail="Invalid internal dispatch signature.")


def require_operator(request: Request) -> None:
  principal = request.state.principal
  if "ai:operate" not in principal.scopes:
    raise HTTPException(status_code=403, detail="Operator access required.")
