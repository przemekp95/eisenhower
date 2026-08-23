from __future__ import annotations

from typing import Literal

from fastapi import Depends, FastAPI, Form, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from .auth import TokenVerifier
from .config import Settings
from .device import get_device
from .defaults import QUADRANT_NAMES
from .jobs import JobConflictError, QueueCapacityExceeded
from .metrics import MetricsRegistry
from .service import QuadrantAIService
from .store import TrainingStore
from .webhooks import parse_webhook_envelope
from .http.composition import build_dependencies
from .http.analysis import create_analysis_router
from .http.errors import register_exception_handlers
from .http.health import create_health_router
from .http.knowledge import create_knowledge_router
from .http.middleware import register_middleware, require_internal_dispatch, require_operator
from .http.ocr import create_ocr_router
from .http.schemas import (
  AnalyzeRequest,
  BatchRequest,
  ClassifyRequest,
  InternalExtractionJobRequest,
  InternalJobRequest,
  KnowledgeAnswerApiRequest,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  OCRAcceptedTask,
  OCRFeedbackRequest,
  ProviderStateRequest,
  RagAnalyzeRequest,
  StrictRequest,
)

MAX_WEBHOOK_BYTES = 8 * 1024 * 1024
WEBHOOK_JOB_TYPES = {
  "upsert": "rag.upsert",
  "tombstone": "rag.tombstone",
  "reindex_project": "rag.reindex_project",
  "start_rag_evaluation": "rag.evaluate",
}


def create_app(
  settings: Settings | None = None,
  store: TrainingStore | None = None,
  ai_service: QuadrantAIService | None = None,
  rag_service=None,
  token_verifier: TokenVerifier | None = None,
  metrics_registry: MetricsRegistry | None = None,
  audit_sink=None,
  memory_runtime=None,
) -> FastAPI:
  dependencies = build_dependencies(
    settings=settings,
    store=store,
    ai_service=ai_service,
    rag_service=rag_service,
    token_verifier=token_verifier,
    metrics_registry=metrics_registry,
    audit_sink=audit_sink,
    memory_runtime=memory_runtime,
  )
  resolved_settings = dependencies.settings
  resolved_store = dependencies.store
  resolved_ai_service = dependencies.ai_service
  resolved_rag_service = dependencies.rag_service
  webhook_verifier = dependencies.webhook_verifier
  job_queue = dependencies.job_queue
  metrics = dependencies.metrics_registry
  resolved_memory_runtime = dependencies.memory_runtime
  response_canary_router = dependencies.response_canary_router
  memory_requested = bool(
    resolved_settings.memory_write_enabled
    or resolved_settings.memory_retrieval_enabled
    or resolved_settings.memory_response_enabled
  )

  app = FastAPI(
    title=resolved_settings.app_name,
    description="Import-safe local task classifier with OCR support.",
  )
  register_middleware(app, dependencies)
  if memory_requested:
    from .memory.routes import create_memory_router

    app.include_router(create_memory_router(
      resolved_memory_runtime,
      write_enabled=resolved_settings.memory_write_enabled,
      retrieval_enabled=resolved_settings.memory_retrieval_enabled,
      metrics=metrics,
    ))
  app.include_router(create_health_router(dependencies))
  app.include_router(create_analysis_router(dependencies))
  app.include_router(create_knowledge_router(dependencies))
  app.include_router(create_ocr_router(dependencies))

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
      try:
        job = job_queue.enqueue(event_id, WEBHOOK_JOB_TYPES[operation], payload)
      except QueueCapacityExceeded as issue:
        raise HTTPException(
          status_code=503,
          detail="Ingestion queue is full; retry later.",
          headers={"Retry-After": "30"},
        ) from issue
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

  @app.post("/add-example")
  def add_training_example(
    text: str = Form(..., min_length=1),
    quadrant: int = Form(..., ge=0, le=3),
    _operator: None = Depends(require_operator),
  ):
    require_management_enabled()
    record = resolved_store.add_example(text=text, quadrant=quadrant)
    return {
      "message": "Training example added.",
      "example": record,
    }

  @app.post("/retrain")
  def retrain_model(preserve_experience: bool = Form(True), _operator: None = Depends(require_operator)):
    require_management_enabled()
    return resolved_ai_service.retrain(preserve_experience=preserve_experience)

  @app.post("/learn-feedback")
  def learn_from_feedback(
    task: str = Form(..., min_length=1),
    predicted_quadrant: int = Form(..., ge=0, le=3),
    correct_quadrant: int = Form(..., ge=0, le=3),
    _operator: None = Depends(require_operator),
  ):
    require_management_enabled()
    return resolved_ai_service.learn_feedback(
      task,
      predicted_quadrant,
      correct_quadrant,
      source="feedback",
    )

  @app.post("/learn-ocr-feedback")
  def learn_from_ocr_feedback(request: OCRFeedbackRequest, _operator: None = Depends(require_operator)):
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
  def get_training_stats(_operator: None = Depends(require_operator)):
    return resolved_ai_service.get_training_stats()

  @app.delete("/training-data")
  def clear_training_data(keep_defaults: bool = Query(True), _operator: None = Depends(require_operator)):
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
    _operator: None = Depends(require_operator),
  ):
    if quadrant not in QUADRANT_NAMES:
      raise HTTPException(status_code=404, detail="Quadrant not found.")
    return {
      "quadrant": quadrant,
      "quadrant_name": QUADRANT_NAMES[quadrant],
      "examples": resolved_store.get_examples(quadrant, limit=limit),
    }

  @app.get("/capabilities")
  def get_capabilities(request: Request):
    caps = resolved_ai_service.capabilities()
    principal = request.state.principal
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
    retrieval_available = bool(
      resolved_rag_service is not None
      and resolved_settings.rag_retrieval_enabled
      and tenant_enabled
    )
    generation_available = bool(
      retrieval_available
      and resolved_settings.rag_generation_enabled
      and getattr(resolved_rag_service, "generation_enabled", True)
    )
    response_available = bool(
      generation_available
      and resolved_settings.rag_response_enabled
      and user_enabled
      and (
        response_canary_router is None
        or response_canary_router.evaluate(principal.tenant_id, principal.user_id).reason is None
      )
    )
    return {
      "classification": caps["classification"],
      "reasoned_local_analysis": caps["reasoned_local_analysis"],
      "knowledge_retrieval": retrieval_available,
      "retrieval_augmented_generation": response_available,
      "local_similar_examples": caps["local_similar_examples"],
      "ocr": caps["ocr"],
      "batch_analysis": caps["batch_analysis"],
      "memory_write": resolved_settings.memory_write_enabled,
      "memory_retrieval": resolved_settings.memory_retrieval_enabled,
      "memory_response": resolved_settings.memory_response_enabled,
    }

  @app.get("/operator/capabilities")
  def get_operator_capabilities(_operator: None = Depends(require_operator)):
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
    _operator: None = Depends(require_operator),
  ):
    require_management_enabled()
    return resolved_ai_service.set_provider_enabled(provider_name, request.enabled)

  register_exception_handlers(app, dependencies)
  return app
