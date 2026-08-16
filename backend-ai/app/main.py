from __future__ import annotations

import logging
import re
import time
from hashlib import sha256
from typing import Literal
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .auth import AuthError, OIDCVerifier, ServiceTokenVerifier, StaticTokenVerifier, TokenVerifier
from .audit import AuditAction, AuditEvent, AuditOutcome, SqliteAuditSink
from .config import Settings, load_settings
from .device import get_device
from .defaults import QUADRANT_NAMES
from .document_extraction.models import OCRRequest
from .local_model import ModelNotReadyError
from .generation.models import KnownStatement
from .jobs import JobConflictError, SqliteJobQueue
from .metrics import MetricsRegistry
from .ops.response_canary import ResponseCanaryRouter
from .rag.errors import RerankerUnavailable
from .rag.models import (
  AccessScope,
  AnalyzeResult,
  Citation,
  KnowledgeAnswerResponse,
  RetrievalSummary,
)
from .service import ProviderDisabledError, QuadrantAIService
from .security_controls import SlidingWindowRateLimiter
from .store import TrainingStore
from .webhooks import WebhookReplayVerifier, parse_webhook_envelope

request_logger = logging.getLogger("uvicorn.error")
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
MAX_TASK_LENGTH = 500
MAX_BATCH_TASKS = 100
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_WEBHOOK_BYTES = 8 * 1024 * 1024
WEBHOOK_JOB_TYPES = {
  "upsert": "rag.upsert",
  "tombstone": "rag.tombstone",
  "reindex_project": "rag.reindex_project",
  "start_rag_evaluation": "rag.evaluate",
}
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
}


class StrictRequest(BaseModel):
  model_config = ConfigDict(extra="forbid")


class RagAnalyzeRequest(StrictRequest):
  task: str = Field(..., min_length=1, max_length=MAX_TASK_LENGTH)
  language: Literal["en", "pl"] = "en"
  known_state: list[KnownStatement] | None = Field(default=None, max_length=40)
  previous_output_statements: list[KnownStatement] | None = Field(default=None, max_length=40)
  freshness_requirement: Literal["snapshot_sufficient", "current_world_required"] = (
    "snapshot_sufficient"
  )

  @model_validator(mode="after")
  def statement_ids_are_globally_unique(self):
    statements = (self.known_state or []) + (self.previous_output_statements or [])
    identifiers = [item.statement_id for item in statements]
    if len(identifiers) != len(set(identifiers)):
      raise ValueError("known and previous-output statement ids must be globally unique")
    return self


class ClassifyRequest(StrictRequest):
  title: str = Field(..., min_length=1, max_length=MAX_TASK_LENGTH)
  use_rag: bool = True


class AnalyzeRequest(StrictRequest):
  task: str = Field(..., min_length=1, max_length=MAX_TASK_LENGTH)
  language: Literal["en", "pl"] = "en"


class KnowledgeSearchRequest(StrictRequest):
  query: str = Field(..., min_length=1, max_length=2000)
  project_id: str | None = Field(default=None, max_length=128)
  limit: int = Field(default=5, ge=1, le=20)


class KnowledgeSearchResponse(StrictRequest):
  query: str
  answer: str | None = None
  citations: list[Citation] = Field(default_factory=list)
  retrieval: RetrievalSummary = Field(default_factory=RetrievalSummary)
  no_answer_reason: str | None = None


class KnowledgeAnswerApiRequest(StrictRequest):
  query: str = Field(..., min_length=1, max_length=2000)
  language: Literal["en", "pl"] = "en"
  project_id: str | None = Field(default=None, max_length=128)
  limit: int = Field(default=5, ge=1, le=20)


class InternalJobRequest(StrictRequest):
  event_id: str = Field(..., min_length=1, max_length=128)
  tenant_id: str = Field(..., min_length=1, max_length=128)
  project_id: str | None = Field(default=None, max_length=128)
  source_version: str = Field(..., min_length=1, max_length=128)
  source_sequence: int = Field(..., ge=0, le=9_223_372_036_854_775_807)
  content_checksum: str = Field(..., pattern=r"^sha256:[a-f0-9]{64}$")
  embedding_version: str = Field(..., min_length=1, max_length=128)
  chunking_version: str = Field(..., min_length=1, max_length=128)
  documents: list[dict] | None = Field(default=None, max_length=500)
  document_ids: list[str] | None = Field(default=None, max_length=5000)
  dataset_version: str | None = Field(default=None, max_length=128)


class InternalExtractionJobRequest(StrictRequest):
  event_id: str = Field(..., min_length=1, max_length=128)
  tenant_id: str = Field(..., min_length=1, max_length=128)
  source: str = Field(..., min_length=1, max_length=4096)
  scope: AccessScope
  source_sequence: int = Field(..., ge=0, le=9_223_372_036_854_775_807)
  ocr: OCRRequest | None = None

  @model_validator(mode="after")
  def scope_must_match_envelope_tenant(self):
    if self.tenant_id != self.scope.tenant_id:
      raise ValueError("envelope tenant does not match access scope")
    return self


class BatchRequest(StrictRequest):
  tasks: list[str] = Field(default_factory=list, max_length=MAX_BATCH_TASKS)


class ProviderStateRequest(StrictRequest):
  enabled: bool


class OCRAcceptedTask(StrictRequest):
  task: str = Field(..., min_length=1, max_length=MAX_TASK_LENGTH)
  quadrant: int = Field(..., ge=0, le=3)


class OCRFeedbackRequest(StrictRequest):
  tasks: list[OCRAcceptedTask] = Field(default_factory=list, max_length=MAX_BATCH_TASKS)
  retrain: bool = True


def create_app(
  settings: Settings | None = None,
  store: TrainingStore | None = None,
  ai_service: QuadrantAIService | None = None,
  rag_service=None,
  token_verifier: TokenVerifier | None = None,
  metrics_registry: MetricsRegistry | None = None,
  audit_sink=None,
) -> FastAPI:
  resolved_settings = settings or load_settings()
  resolved_store = store or TrainingStore(resolved_settings.training_data_path)

  resolved_ai_service = ai_service or QuadrantAIService(
      settings=resolved_settings,
      store=resolved_store,
  )
  resolved_rag_service = rag_service
  if resolved_rag_service is None and resolved_settings.rag_retrieval_enabled:
    from .rag.bootstrap import build_rag_service

    resolved_rag_service = build_rag_service(resolved_settings, resolved_ai_service)
  response_canary_router = (
    ResponseCanaryRouter(
      resolved_settings.rag_response_promotion_pointer_path,
      candidate_id=str(resolved_settings.rag_response_candidate_id),
    )
    if resolved_settings.rag_response_promotion_pointer_path
    and resolved_settings.rag_response_candidate_id
    else None
  )
  resolved_settings.model_cache_dir.mkdir(parents=True, exist_ok=True)
  resolved_verifier = token_verifier
  if resolved_verifier is None:
    if resolved_settings.auth_mode == "oidc":
      resolved_verifier = OIDCVerifier(
        issuer=str(resolved_settings.oidc_issuer),
        audience=str(resolved_settings.oidc_audience),
        jwks_url=resolved_settings.oidc_jwks_url,
      )
    else:
      resolved_verifier = StaticTokenVerifier(
        user_token=resolved_settings.api_token,
        admin_token=resolved_settings.admin_token,
      )
  internal_verifier = None
  webhook_verifier = None
  job_queue = None
  if resolved_settings.internal_api_token:
    internal_verifier = ServiceTokenVerifier(
      token=resolved_settings.internal_api_token,
      service_id="n8n-ingestion",
      scopes=["rag:ingest"],
    )
    job_queue = SqliteJobQueue(resolved_settings.jobs_database_path)
  if resolved_settings.webhook_secret:
    webhook_verifier = WebhookReplayVerifier(
      resolved_settings.model_cache_dir / "webhook-replay.sqlite3",
      secret=resolved_settings.webhook_secret,
    )
  ai_rate_limiter = SlidingWindowRateLimiter(limit=30, window_seconds=60)
  metrics = metrics_registry or MetricsRegistry()
  metrics.set_release_sha(resolved_settings.release_sha)
  audit = audit_sink or SqliteAuditSink(
    resolved_settings.audit_database_path,
    hmac_key=resolved_settings.audit_hmac_key.encode("utf-8"),
  )

  app = FastAPI(
    title=resolved_settings.app_name,
    description="Import-safe local task classifier with OCR support.",
  )
  app.add_middleware(
    CORSMiddleware,
    allow_origins=list(resolved_settings.cors_allow_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
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
          release_sha=resolved_settings.release_sha,
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
    if action is None or request.method not in UNSAFE_METHODS:
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
    if origin and request.method in UNSAFE_METHODS and origin not in resolved_settings.cors_allow_origins:
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
      verifier = internal_verifier if request.url.path.startswith("/internal/") else resolved_verifier
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

  def require_internal_dispatch(
    request: Request,
    envelope: InternalJobRequest | InternalExtractionJobRequest,
    operation: str,
  ) -> None:
    principal = request.state.principal
    if "rag:ingest" not in principal.scopes or webhook_verifier is None:
      raise HTTPException(status_code=403, detail="Internal ingestion is disabled.")
    if envelope.tenant_id not in resolved_settings.internal_allowed_tenants:
      raise HTTPException(status_code=403, detail="Tenant is outside the connector scope.")
    signature = request.headers.get("x-eisenhower-signature", "")
    if not webhook_verifier.verify_internal_dispatch(
      signature,
      envelope.event_id,
      envelope.tenant_id,
      operation,
    ):
      raise HTTPException(status_code=403, detail="Invalid internal dispatch signature.")

  def require_admin(request: Request) -> None:
    principal = request.state.principal
    if "admin" not in principal.roles and "*" not in principal.scopes:
      raise HTTPException(status_code=403, detail="Administrator access required.")

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

  @app.get("/")
  def root():
    return {"service": resolved_settings.app_name, "status": "ok"}

  @app.get("/metrics", include_in_schema=False)
  def prometheus_metrics():
    metrics.set_job_queue_enabled(job_queue is not None)
    if job_queue is not None:
      metrics.set_job_depths(job_queue.counts_by_status())
      metrics.set_job_depths_by_type(job_queue.counts_by_type_and_status())
      metrics.set_job_worker_heartbeat_age(job_queue.latest_worker_heartbeat_age_seconds())
    generation_status = (
      resolved_rag_service.generation_status()
      if resolved_rag_service is not None and hasattr(resolved_rag_service, "generation_status")
      else {"state": "disabled", "failures": 0}
    )
    metrics.set_generation_status(
      str(generation_status.get("state", "unknown")),
      failures=int(generation_status.get("failures", 0)),
    )
    return Response(content=metrics.render(), media_type="text/plain; version=0.0.4")

  @app.get("/health/live", include_in_schema=False)
  def health_live():
    return {"status": "ok"}

  @app.get("/health/ready", include_in_schema=False)
  def health_ready():
    capabilities = resolved_ai_service.capabilities()
    if not capabilities.get("classification"):
      raise HTTPException(status_code=503, detail="Local classifier is not ready.")
    generation_status = (
      resolved_rag_service.generation_status()
      if resolved_rag_service is not None and hasattr(resolved_rag_service, "generation_status")
      else {"enabled": False, "state": "disabled", "failures": 0}
    )
    return {
      "status": "ready",
      "generation_id": capabilities.get("model", {}).get("generation_id"),
      "optional_dependencies": {"generation": generation_status},
    }

  @app.post("/v2/ai/analyze", response_model=AnalyzeResult)
  def analyze_with_rag(request: RagAnalyzeRequest, http_request: Request):
    analysis_started = time.perf_counter()
    principal = http_request.state.principal
    if "*" not in principal.scopes and "ai:analyze" not in principal.scopes:
      raise HTTPException(status_code=403, detail="Missing ai:analyze scope.")
    scope = AccessScope(
      tenant_id=principal.tenant_id,
      user_id=principal.user_id,
      project_ids=principal.project_ids,
      roles=principal.roles,
    )
    tenant_enabled = (
      not resolved_settings.rag_allowed_tenants
      or principal.tenant_id in resolved_settings.rag_allowed_tenants
    )
    user_enabled = (
      (
        resolved_settings.app_env != "production"
        and not resolved_settings.rag_response_allowed_users
      )
      or principal.user_id in resolved_settings.rag_response_allowed_users
    )
    generation_enabled = bool(
      resolved_rag_service is not None
      and getattr(resolved_rag_service, "generation_enabled", True)
    )
    current_world_abstention = (
      resolved_rag_service is not None
      and tenant_enabled
      and request.freshness_requirement == "current_world_required"
    )
    response_promotion_reason = None
    if (
      response_canary_router is not None
      and resolved_settings.rag_response_enabled
      and generation_enabled
      and tenant_enabled
      and user_enabled
    ):
      response_canary_decision = response_canary_router.evaluate(
        principal.tenant_id, principal.user_id
      )
      metrics.observe_response_canary(response_canary_decision.outcome)
      response_promotion_reason = response_canary_decision.reason
    response_enabled = (
      generation_enabled
      and resolved_settings.rag_response_enabled
      and tenant_enabled
      and user_enabled
      and response_promotion_reason is None
    )
    if (
      resolved_rag_service is not None
      and response_enabled
    ) or current_world_abstention:
      delta_requested = (
        request.known_state is not None
        or request.previous_output_statements is not None
        or request.freshness_requirement == "current_world_required"
      )
      if delta_requested:
        result = resolved_rag_service.analyze(
          request.task,
          scope,
          language=request.language,
          known_state=request.known_state,
          previous_output_statements=request.previous_output_statements,
          freshness_requirement=request.freshness_requirement,
        )
      else:
        result = resolved_rag_service.analyze(request.task, scope, language=request.language)
    else:
      if resolved_rag_service is not None and tenant_enabled and generation_enabled:
        generation_started = time.perf_counter()
        try:
          shadow_result = resolved_rag_service.analyze(
            request.task,
            scope,
            language=request.language,
          )
          shadow_outcome = "no_answer" if shadow_result.mode == "no_answer" else "success"
          metrics.observe_generation(
            shadow_outcome,
            duration_seconds=time.perf_counter() - generation_started,
            input_tokens=(
              shadow_result.generation.input_tokens
              if shadow_result.generation is not None
              else 0
            ),
          )
          if shadow_result.generation is not None:
            metrics.observe_rag_validation("schema", "accepted")
            if shadow_result.mode == "rag":
              metrics.observe_rag_validation("citations", "accepted")
        except Exception:
          request_logger.warning("Optional generation shadow failed", exc_info=True)
          metrics.observe_generation(
            "unavailable",
            duration_seconds=time.perf_counter() - generation_started,
            input_tokens=0,
          )
      elif resolved_rag_service is not None and tenant_enabled:
        retrieval_started = time.perf_counter()
        try:
          shadow = resolved_rag_service.retrieve_summary(request.task, scope)
          metrics.observe_rag_retrieval(
            "shadow",
            hit_count=shadow.hit_count,
            duration_seconds=time.perf_counter() - retrieval_started,
          )
        except Exception:
          request_logger.warning("Optional shadow retrieval failed", exc_info=True)
          metrics.observe_rag_retrieval(
            "shadow",
            hit_count=None,
            duration_seconds=time.perf_counter() - retrieval_started,
          )
      classification = resolved_ai_service.classify_task(request.task, use_rag=False)
      if resolved_rag_service is None:
        fallback_reason = "rag_disabled"
      elif not resolved_settings.rag_response_enabled:
        fallback_reason = "rag_response_disabled"
      elif not generation_enabled:
        fallback_reason = "generation_disabled"
      elif not tenant_enabled:
        fallback_reason = "tenant_not_enabled"
      elif not user_enabled:
        fallback_reason = "user_not_enabled"
      else:
        fallback_reason = response_promotion_reason or "response_promotion_invalid"
      result = AnalyzeResult(
        mode="fallback",
        quadrant=classification["quadrant"],
        quadrant_name=classification["quadrant_name"],
        confidence=classification["confidence"],
        explanation="The local MiniLM classifier produced this fallback result.",
        retrieval=RetrievalSummary(),
        fallback_reason=fallback_reason,
      )
    analysis_duration = time.perf_counter() - analysis_started
    metrics.observe_rag_result(result.mode, result.fallback_reason)
    metrics.observe_rag_analysis(result.mode, duration_seconds=analysis_duration)
    if result.information_delta is not None:
      metrics.observe_information_delta(result.information_delta.status)
      metrics.observe_rag_validation("information_delta", "accepted")
    if result.generation is not None:
      generation_outcome = "no_answer" if result.mode == "no_answer" else "success"
      metrics.observe_generation(
        generation_outcome,
        duration_seconds=analysis_duration,
        input_tokens=result.generation.input_tokens,
      )
      metrics.observe_rag_validation("schema", "accepted")
      if result.mode == "rag":
        metrics.observe_rag_validation("citations", "accepted")
    elif result.fallback_reason == "invalid_generation_output":
      metrics.observe_generation("rejected", duration_seconds=analysis_duration, input_tokens=0)
      metrics.observe_rag_validation("schema", "rejected")
    elif result.fallback_reason == "invalid_citations":
      metrics.observe_generation("rejected", duration_seconds=analysis_duration, input_tokens=0)
      metrics.observe_rag_validation("citations", "rejected")
    elif result.fallback_reason == "invalid_information_delta":
      metrics.observe_generation("rejected", duration_seconds=analysis_duration, input_tokens=0)
      metrics.observe_rag_validation("information_delta", "rejected")
    elif result.fallback_reason == "generation_unavailable":
      metrics.observe_generation("unavailable", duration_seconds=analysis_duration, input_tokens=0)
    return result

  @app.post("/v2/knowledge/search", response_model=KnowledgeSearchResponse)
  def search_knowledge(request: KnowledgeSearchRequest, http_request: Request):
    principal = http_request.state.principal
    if "*" not in principal.scopes and not ({"knowledge:read", "ai:analyze"} & set(principal.scopes)):
      raise HTTPException(status_code=403, detail="Missing knowledge:read scope.")
    project_ids = list(principal.project_ids)
    if request.project_id:
      if "admin" not in principal.roles and request.project_id not in project_ids:
        raise HTTPException(status_code=403, detail="Project is outside the authenticated scope.")
      project_ids = [request.project_id]
    scope = AccessScope(
      tenant_id=principal.tenant_id,
      user_id=principal.user_id,
      project_ids=project_ids,
      roles=principal.roles,
    )
    if resolved_rag_service is None:
      return {
        "query": request.query,
        "answer": None,
        "citations": [],
        "retrieval": RetrievalSummary(),
        "no_answer_reason": "rag_disabled",
      }
    retrieval_started = time.perf_counter()
    try:
      result = resolved_rag_service.search(
        request.query,
        scope,
        limit=request.limit,
        project_id=request.project_id,
      )
    except RerankerUnavailable as error:
      metrics.observe_rag_retrieval(
        "search",
        hit_count=None,
        duration_seconds=time.perf_counter() - retrieval_started,
      )
      raise HTTPException(
        status_code=503,
        detail="Default retrieval reranker is unavailable.",
      ) from error
    except Exception:
      metrics.observe_rag_retrieval(
        "search",
        hit_count=None,
        duration_seconds=time.perf_counter() - retrieval_started,
      )
      raise
    metrics.observe_rag_retrieval(
      "search",
      hit_count=result["retrieval"].hit_count,
      duration_seconds=time.perf_counter() - retrieval_started,
    )
    return result

  @app.post("/v2/knowledge/answer", response_model=KnowledgeAnswerResponse)
  def answer_knowledge(request: KnowledgeAnswerApiRequest, http_request: Request):
    principal = http_request.state.principal
    if "*" not in principal.scopes and not ({"knowledge:read", "ai:analyze"} & set(principal.scopes)):
      raise HTTPException(status_code=403, detail="Missing knowledge:read scope.")
    project_ids = list(principal.project_ids)
    if request.project_id:
      if "admin" not in principal.roles and request.project_id not in project_ids:
        raise HTTPException(status_code=403, detail="Project is outside the authenticated scope.")
      project_ids = [request.project_id]
    scope = AccessScope(
      tenant_id=principal.tenant_id,
      user_id=principal.user_id,
      project_ids=project_ids,
      roles=principal.roles,
    )
    tenant_enabled = (
      not resolved_settings.rag_allowed_tenants
      or principal.tenant_id in resolved_settings.rag_allowed_tenants
    )
    user_enabled = (
      (
        resolved_settings.app_env != "production"
        and not resolved_settings.rag_response_allowed_users
      )
      or principal.user_id in resolved_settings.rag_response_allowed_users
    )
    generation_enabled = bool(
      resolved_rag_service is not None
      and getattr(resolved_rag_service, "generation_enabled", True)
    )
    if resolved_rag_service is None:
      reason = "rag_disabled"
    elif not resolved_settings.rag_response_enabled:
      reason = "rag_response_disabled"
    elif not generation_enabled:
      reason = "generation_disabled"
    elif not tenant_enabled:
      reason = "tenant_not_enabled"
    elif not user_enabled:
      reason = "user_not_enabled"
    elif response_canary_router is not None:
      response_canary_decision = response_canary_router.evaluate(
        principal.tenant_id, principal.user_id
      )
      metrics.observe_response_canary(response_canary_decision.outcome)
      reason = response_canary_decision.reason
    else:
      reason = None
    if reason is not None:
      return KnowledgeAnswerResponse(
        status="insufficient_evidence",
        answer=None,
        claims=[],
        citations=[],
        retrieval=RetrievalSummary(),
        no_answer_reason=reason,
      )

    started = time.perf_counter()
    result = resolved_rag_service.answer(
      request.query,
      scope,
      language=request.language,
      limit=request.limit,
      project_id=request.project_id,
    )
    metrics.observe_rag_retrieval(
      "answer",
      hit_count=result.retrieval.hit_count,
      duration_seconds=time.perf_counter() - started,
    )
    generation_outcome = (
      "success" if result.status == "answered" else "no_answer"
    )
    metrics.observe_generation(
      generation_outcome,
      duration_seconds=time.perf_counter() - started,
      input_tokens=result.generation.input_tokens if result.generation else 0,
    )
    return result

  @app.post("/internal/webhooks/n8n/verify")
  async def verify_n8n_webhook(http_request: Request):
    if "rag:ingest" not in http_request.state.principal.scopes or webhook_verifier is None:
      raise HTTPException(status_code=403, detail="Webhook ingestion is disabled.")
    media_type = http_request.headers.get("content-type", "").partition(";")[0].strip().lower()
    if media_type != "application/json":
      raise HTTPException(status_code=415, detail="Webhook body must use application/json.")
    content_length = http_request.headers.get("content-length")
    if content_length is not None:
      try:
        declared_length = int(content_length)
      except ValueError as exception:
        raise HTTPException(status_code=400, detail="Invalid Content-Length header.") from exception
      if declared_length < 0:
        raise HTTPException(status_code=400, detail="Invalid Content-Length header.")
      if declared_length > MAX_WEBHOOK_BYTES:
        raise HTTPException(status_code=413, detail="Webhook body exceeds the 8 MiB limit.")
    body_buffer = bytearray()
    async for chunk in http_request.stream():
      if len(body_buffer) + len(chunk) > MAX_WEBHOOK_BYTES:
        raise HTTPException(status_code=413, detail="Webhook body exceeds the 8 MiB limit.")
      body_buffer.extend(chunk)
    raw_body = bytes(body_buffer)
    timestamp = http_request.headers.get("x-eisenhower-timestamp", "")
    signature = http_request.headers.get("x-eisenhower-signature", "")
    version = http_request.headers.get("x-eisenhower-signature-version", "")
    signed_method = http_request.headers.get("x-eisenhower-signed-method", "")
    signed_path = http_request.headers.get("x-eisenhower-signed-path", "")
    if not webhook_verifier.verify_signature(
      timestamp,
      signature,
      raw_body,
      method=signed_method,
      path=signed_path,
      version=version,
    ):
      return {"accepted": False}
    try:
      envelope = parse_webhook_envelope(raw_body)
    except (UnicodeDecodeError, ValueError) as exception:
      raise HTTPException(status_code=422, detail="Invalid ingestion envelope.") from exception
    event_id = str(envelope.event_id)
    tenant_id = envelope.tenant_id
    if job_queue is None:
      raise HTTPException(status_code=503, detail="Durable job queue is disabled.")
    if tenant_id not in resolved_settings.internal_allowed_tenants:
      raise HTTPException(status_code=403, detail="Tenant is outside the connector scope.")
    operation = envelope.operation
    signed_payload = envelope.model_dump(mode="json", exclude_none=True, exclude_unset=True)
    payload = {
      key: value
      for key, value in signed_payload.items()
      if key not in {"operation", "schema_version"}
    }
    try:
      job = job_queue.enqueue(event_id, WEBHOOK_JOB_TYPES[operation], payload)
    except JobConflictError as exception:
      raise HTTPException(status_code=409, detail=str(exception)) from exception
    if not webhook_verifier.reserve_event(event_id):
      return {"accepted": False, "job_id": job.job_id, "status": job.status}
    return {
      "accepted": True,
      "job_id": job.job_id,
      "status": job.status,
      "envelope": signed_payload,
      "internal_signature": webhook_verifier.sign_internal_dispatch(
        event_id,
        tenant_id,
        operation,
      ),
    }

  def require_management_enabled() -> None:
    if not resolved_settings.ai_management_enabled:
      raise HTTPException(status_code=403, detail="Training management is disabled in this environment.")

  def enqueue_internal_job(
    operation: str,
    job_type: str,
    envelope: InternalJobRequest | InternalExtractionJobRequest,
    http_request: Request,
    *,
    include_none: bool = False,
  ):
    if job_queue is None:
      raise HTTPException(status_code=503, detail="Durable job queue is disabled.")
    require_internal_dispatch(http_request, envelope, operation)
    idempotency_key = http_request.headers.get("idempotency-key", "")
    if idempotency_key != envelope.event_id:
      raise HTTPException(status_code=400, detail="Idempotency-Key must equal event_id.")
    try:
      job = job_queue.enqueue(
        idempotency_key,
        job_type,
        envelope.model_dump(exclude_none=not include_none),
      )
    except JobConflictError as exception:
      raise HTTPException(status_code=409, detail=str(exception)) from exception
    return JSONResponse(
      status_code=202,
      content={"job_id": job.job_id, "status": job.status},
    )

  @app.post("/internal/rag/ingestion/upsert", status_code=202)
  def enqueue_upsert(envelope: InternalJobRequest, http_request: Request):
    if not envelope.documents:
      raise HTTPException(status_code=422, detail="documents are required.")
    return enqueue_internal_job("upsert", "rag.upsert", envelope, http_request)

  @app.post("/internal/rag/ingestion/tombstone", status_code=202)
  def enqueue_tombstone(envelope: InternalJobRequest, http_request: Request):
    if not envelope.document_ids:
      raise HTTPException(status_code=422, detail="document_ids are required.")
    return enqueue_internal_job("tombstone", "rag.tombstone", envelope, http_request)

  @app.post("/internal/rag/ingestion/extract", status_code=202)
  def enqueue_extraction(envelope: InternalExtractionJobRequest, http_request: Request):
    return enqueue_internal_job(
      "extract_document",
      "rag.extract_document",
      envelope,
      http_request,
      include_none=True,
    )

  @app.post("/internal/rag/reindex", status_code=202)
  def enqueue_reindex(envelope: InternalJobRequest, http_request: Request):
    if not envelope.project_id:
      raise HTTPException(status_code=422, detail="project_id is required.")
    return enqueue_internal_job("reindex_project", "rag.reindex_project", envelope, http_request)

  @app.post("/internal/rag/evaluations", status_code=202)
  def enqueue_evaluation(envelope: InternalJobRequest, http_request: Request):
    if not envelope.dataset_version:
      raise HTTPException(status_code=422, detail="dataset_version is required.")
    return enqueue_internal_job("start_rag_evaluation", "rag.evaluate", envelope, http_request)

  @app.post("/classify")
  def classify_text(request: ClassifyRequest):
    return resolved_ai_service.classify_task(request.title, use_rag=request.use_rag)

  @app.post("/analyze")
  def analyze_with_langchain(request: AnalyzeRequest):
    return resolved_ai_service.analyze_with_reasoning(request.task, language=request.language)

  @app.post("/analyze-langchain", deprecated=True, include_in_schema=False)
  def analyze_with_legacy_name(request: AnalyzeRequest):
    return resolved_ai_service.analyze_with_reasoning(request.task, language=request.language)

  @app.post("/extract-tasks-from-image")
  async def extract_tasks_from_image(file: UploadFile = File(...)):
    payload = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(payload) > MAX_UPLOAD_BYTES:
      raise HTTPException(status_code=413, detail="Upload exceeds the 10 MiB limit.")
    return resolved_ai_service.extract_tasks_from_image(file.filename or "upload", payload, file.content_type)

  @app.post("/batch-analyze")
  def batch_analyze_tasks(request: BatchRequest):
    tasks = [task.strip() for task in request.tasks if task.strip()]
    if not tasks:
      raise HTTPException(status_code=400, detail="At least one task is required.")
    if any(len(task) > MAX_TASK_LENGTH for task in tasks):
      raise HTTPException(status_code=422, detail=f"Each task must be at most {MAX_TASK_LENGTH} characters.")
    return resolved_ai_service.batch_analyze(tasks)

  @app.post("/add-example")
  def add_training_example(
    text: str = Form(..., min_length=1),
    quadrant: int = Form(..., ge=0, le=3),
    _admin: None = Depends(require_admin),
  ):
    require_management_enabled()
    record = resolved_store.add_example(text=text, quadrant=quadrant)
    return {
      "message": "Training example added.",
      "example": record,
    }

  @app.post("/retrain")
  def retrain_model(preserve_experience: bool = Form(True), _admin: None = Depends(require_admin)):
    require_management_enabled()
    return resolved_ai_service.retrain(preserve_experience=preserve_experience)

  @app.post("/learn-feedback")
  def learn_from_feedback(
    task: str = Form(..., min_length=1),
    predicted_quadrant: int = Form(..., ge=0, le=3),
    correct_quadrant: int = Form(..., ge=0, le=3),
    _admin: None = Depends(require_admin),
  ):
    require_management_enabled()
    return resolved_ai_service.learn_feedback(
      task,
      predicted_quadrant,
      correct_quadrant,
      source="feedback",
    )

  @app.post("/learn-ocr-feedback")
  def learn_from_ocr_feedback(request: OCRFeedbackRequest, _admin: None = Depends(require_admin)):
    require_management_enabled()
    if not request.tasks:
      raise HTTPException(status_code=400, detail="At least one accepted OCR task is required.")

    return resolved_ai_service.learn_feedback_batch(
      [
        {
          "task": item.task,
          "predicted_quadrant": item.quadrant,
          "correct_quadrant": item.quadrant,
        }
        for item in request.tasks
      ],
      source="ocr-feedback",
      retrain=request.retrain,
    )

  @app.get("/training-stats")
  def get_training_stats(_admin: None = Depends(require_admin)):
    return resolved_ai_service.get_training_stats()

  @app.delete("/training-data")
  def clear_training_data(keep_defaults: bool = Query(True), _admin: None = Depends(require_admin)):
    require_management_enabled()
    records = resolved_store.clear(keep_defaults=keep_defaults)
    return {
      "message": "Training data cleared.",
      "remaining_examples": len(records),
    }

  @app.get("/examples/{quadrant}")
  def get_examples_by_quadrant(
    quadrant: int,
    limit: int = Query(10, ge=1, le=100),
    _admin: None = Depends(require_admin),
  ):
    if quadrant not in QUADRANT_NAMES:
      raise HTTPException(status_code=404, detail="Quadrant not found.")
    return {
      "quadrant": quadrant,
      "quadrant_name": QUADRANT_NAMES[quadrant],
      "examples": resolved_store.get_examples(quadrant, limit=limit),
    }

  @app.get("/capabilities")
  def get_capabilities():
    caps = resolved_ai_service.capabilities()
    device = get_device()
    caps["device"] = {
      "type": device.type,
      "name": device.name,
      "vendor": device.vendor,
      "runtime": device.runtime,
      "runtime_version": device.runtime_version,
      "torch_device": device.torch_device,
      "count": device.device_count,
      "cuda_version": device.cuda_version,
      "accelerated": device.type != "cpu"
    }
    return caps

  @app.put("/providers/{provider_name}")
  def update_provider(
    provider_name: Literal["local_model", "tesseract"],
    request: ProviderStateRequest,
    _admin: None = Depends(require_admin),
  ):
    require_management_enabled()
    return resolved_ai_service.set_provider_enabled(provider_name, request.enabled)

  @app.exception_handler(HTTPException)
  async def http_exception_handler(_request, exception: HTTPException):
    return JSONResponse(status_code=exception.status_code, content={"error": exception.detail})

  @app.exception_handler(ModelNotReadyError)
  async def model_not_ready_handler(_request, exception: ModelNotReadyError):
    return JSONResponse(status_code=503, content={"error": str(exception), "code": "model_not_ready"})

  @app.exception_handler(ProviderDisabledError)
  async def provider_disabled_handler(_request, exception: ProviderDisabledError):
    return JSONResponse(status_code=503, content={"error": str(exception), "code": "provider_disabled"})

  return app
