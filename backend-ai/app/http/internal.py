from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from ..jobs import JobConflictError, QueueCapacityExceeded
from ..webhooks import parse_webhook_envelope
from .composition import AppDependencies
from .middleware import require_internal_dispatch
from .schemas import InternalExtractionJobRequest, InternalJobRequest


MAX_WEBHOOK_BYTES = 8 * 1024 * 1024
WEBHOOK_JOB_TYPES = {
  "upsert": "rag.upsert",
  "tombstone": "rag.tombstone",
  "reindex_project": "rag.reindex_project",
  "start_rag_evaluation": "rag.evaluate",
}


def create_internal_router(deps: AppDependencies) -> APIRouter:
  router = APIRouter()
  settings = deps.settings
  webhook_verifier = deps.webhook_verifier
  job_queue = deps.job_queue

  @router.post("/internal/webhooks/n8n/verify")
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
    if tenant_id not in settings.internal_allowed_tenants:
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

  @router.post("/internal/rag/ingestion/upsert", status_code=202)
  def enqueue_upsert(envelope: InternalJobRequest, http_request: Request):
    if not envelope.documents:
      raise HTTPException(status_code=422, detail="documents are required.")
    return enqueue_internal_job("upsert", "rag.upsert", envelope, http_request)

  @router.post("/internal/rag/ingestion/tombstone", status_code=202)
  def enqueue_tombstone(envelope: InternalJobRequest, http_request: Request):
    if not envelope.document_ids:
      raise HTTPException(status_code=422, detail="document_ids are required.")
    return enqueue_internal_job("tombstone", "rag.tombstone", envelope, http_request)

  @router.post("/internal/rag/ingestion/extract", status_code=202)
  def enqueue_extraction(envelope: InternalExtractionJobRequest, http_request: Request):
    return enqueue_internal_job(
      "extract_document",
      "rag.extract_document",
      envelope,
      http_request,
      include_none=True,
    )

  @router.post("/internal/rag/reindex", status_code=202)
  def enqueue_reindex(envelope: InternalJobRequest, http_request: Request):
    if not envelope.project_id:
      raise HTTPException(status_code=422, detail="project_id is required.")
    return enqueue_internal_job("reindex_project", "rag.reindex_project", envelope, http_request)

  @router.post("/internal/rag/evaluations", status_code=202)
  def enqueue_evaluation(envelope: InternalJobRequest, http_request: Request):
    if not envelope.dataset_version:
      raise HTTPException(status_code=422, detail="dataset_version is required.")
    return enqueue_internal_job("start_rag_evaluation", "rag.evaluate", envelope, http_request)

  return router
