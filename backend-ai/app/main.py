from __future__ import annotations

import logging
import time
from hashlib import sha256
from hmac import compare_digest
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .config import Settings, load_settings
from .device import get_device
from .defaults import QUADRANT_NAMES
from .local_model import ModelNotReadyError
from .service import ProviderDisabledError, QuadrantAIService
from .store import TrainingStore

request_logger = logging.getLogger("uvicorn.error")


MAX_TASK_LENGTH = 500
MAX_BATCH_TASKS = 100
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class StrictRequest(BaseModel):
  model_config = ConfigDict(extra="forbid")


class ClassifyRequest(StrictRequest):
  title: str = Field(..., min_length=1, max_length=MAX_TASK_LENGTH)
  use_rag: bool = True


class AnalyzeRequest(StrictRequest):
  task: str = Field(..., min_length=1, max_length=MAX_TASK_LENGTH)
  language: Literal["en", "pl"] = "en"


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
) -> FastAPI:
  resolved_settings = settings or load_settings()
  resolved_store = store or TrainingStore(resolved_settings.training_data_path)

  resolved_ai_service = ai_service or QuadrantAIService(
      settings=resolved_settings,
      store=resolved_store,
  )
  resolved_settings.model_cache_dir.mkdir(parents=True, exist_ok=True)

  app = FastAPI(
    title=resolved_settings.app_name,
    description="Import-safe local task classifier with OCR support.",
  )
  app.add_middleware(
    CORSMiddleware,
    allow_origins=list(resolved_settings.cors_allow_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
  )

  def token_matches(supplied_token: str, expected_token: str) -> bool:
    if not expected_token:
      return False
    supplied_digest = sha256(supplied_token.encode("utf-8")).digest()
    expected_digest = sha256(expected_token.encode("utf-8")).digest()
    return compare_digest(supplied_digest, expected_digest)

  def require_admin(request: Request) -> None:
    if getattr(request.state, "auth_role", None) != "admin":
      raise HTTPException(status_code=403, detail="Administrator access required")

  @app.middleware("http")
  async def authenticate_requests(request: Request, call_next):
    if request.url.path == "/" or request.method == "OPTIONS":
      return await call_next(request)

    origin = request.headers.get("origin")
    if (
      origin
      and request.method in UNSAFE_METHODS
      and origin not in resolved_settings.cors_allow_origins
    ):
      return JSONResponse(status_code=403, content={"error": "Untrusted browser origin"})

    authorization = request.headers.get("authorization")
    if not authorization or not authorization.startswith("Bearer "):
      return JSONResponse(
        status_code=401,
        content={"error": "Authentication required"},
        headers={"WWW-Authenticate": "Bearer"},
      )

    supplied_token = authorization.removeprefix("Bearer ")
    if token_matches(supplied_token, resolved_settings.admin_token):
      request.state.auth_role = "admin"
    elif token_matches(supplied_token, resolved_settings.api_token):
      request.state.auth_role = "user"
    else:
      return JSONResponse(status_code=403, content={"error": "Access denied"})

    return await call_next(request)

  @app.middleware("http")
  async def log_requests(request: Request, call_next):
    if request.url.path == "/" or request.method == "OPTIONS":
      return await call_next(request)

    started_at = time.perf_counter()
    response = await call_next(request)
    duration_ms = int((time.perf_counter() - started_at) * 1000)
    message = f"backend-ai {request.method} {request.url.path} {response.status_code} {duration_ms}ms"

    if response.status_code >= 500:
      request_logger.error(message)
    else:
      request_logger.info(message)

    return response

  @app.get("/")
  def root():
    return {"status": "ok"}

  @app.post("/classify")
  def classify_text(request: ClassifyRequest):
    return resolved_ai_service.classify_task(request.title, use_rag=request.use_rag)

  @app.post("/analyze-langchain")
  def analyze_with_langchain(
    request: AnalyzeRequest,
  ):
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
    text: str = Form(..., min_length=1, max_length=MAX_TASK_LENGTH),
    quadrant: int = Form(..., ge=0, le=3),
    _admin: None = Depends(require_admin),
  ):
    record = resolved_store.add_example(text=text, quadrant=quadrant)
    return {
      "message": "Training example added.",
      "example": record,
    }

  @app.post("/retrain")
  def retrain_model(
    preserve_experience: bool = Form(True),
    _admin: None = Depends(require_admin),
  ):
    return resolved_ai_service.retrain(preserve_experience=preserve_experience)

  @app.post("/learn-feedback")
  def learn_from_feedback(
    task: str = Form(..., min_length=1, max_length=MAX_TASK_LENGTH),
    predicted_quadrant: int = Form(..., ge=0, le=3),
    correct_quadrant: int = Form(..., ge=0, le=3),
    _admin: None = Depends(require_admin),
  ):
    return resolved_ai_service.learn_feedback(
      task,
      predicted_quadrant,
      correct_quadrant,
      source="feedback",
    )

  @app.post("/learn-ocr-feedback")
  def learn_from_ocr_feedback(
    request: OCRFeedbackRequest,
    _admin: None = Depends(require_admin),
  ):
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
  def clear_training_data(
    keep_defaults: bool = Query(True),
    _admin: None = Depends(require_admin),
  ):
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
