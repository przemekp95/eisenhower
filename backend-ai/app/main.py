from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .config import Settings, load_settings
from .defaults import QUADRANT_NAMES
from .local_model import ModelNotReadyError
from .service import ProviderDisabledError, QuadrantAIService
from .store import TrainingStore

request_logger = logging.getLogger("uvicorn.error")


class BatchRequest(BaseModel):
  tasks: list[str] = Field(default_factory=list)


class ProviderStateRequest(BaseModel):
  enabled: bool


class OCRAcceptedTask(BaseModel):
  task: str = Field(..., min_length=1)
  quadrant: int = Field(..., ge=0, le=3)


class OCRFeedbackRequest(BaseModel):
  tasks: list[OCRAcceptedTask] = Field(default_factory=list)
  retrain: bool = True


def create_app(
  settings: Settings | None = None,
  store: TrainingStore | None = None,
  ai_service: QuadrantAIService | None = None,
) -> FastAPI:
  resolved_settings = settings or load_settings()
  resolved_store = store or TrainingStore(resolved_settings.training_data_path)
  resolved_ai_service = ai_service or QuadrantAIService(settings=resolved_settings, store=resolved_store)
  resolved_settings.model_cache_dir.mkdir(parents=True, exist_ok=True)

  app = FastAPI(
    title=resolved_settings.app_name,
    description="Import-safe local task classifier with OCR support.",
  )
  app.add_middleware(
    CORSMiddleware,
    allow_origins=list(resolved_settings.cors_allow_origins),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
  )

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
    return {
      "service": resolved_settings.app_name,
      "status": "ok",
      "timestamp": datetime.now(timezone.utc).isoformat(),
    }

  @app.get("/classify")
  def classify_text(
    title: str = Query(..., min_length=1),
    use_rag: bool = Query(True),
  ):
    return resolved_ai_service.classify_task(title, use_rag=use_rag)

  @app.post("/analyze-langchain")
  def analyze_with_langchain(
    task: str = Query(..., min_length=1),
    language: Literal["en", "pl"] = Query("en"),
  ):
    return resolved_ai_service.analyze_with_reasoning(task, language=language)

  @app.post("/extract-tasks-from-image")
  async def extract_tasks_from_image(file: UploadFile = File(...)):
    payload = await file.read()
    return resolved_ai_service.extract_tasks_from_image(file.filename or "upload", payload, file.content_type)

  @app.post("/batch-analyze")
  def batch_analyze_tasks(request: BatchRequest):
    tasks = [task.strip() for task in request.tasks if task.strip()]
    if not tasks:
      raise HTTPException(status_code=400, detail="At least one task is required.")
    return resolved_ai_service.batch_analyze(tasks)

  @app.post("/add-example")
  def add_training_example(
    text: str = Form(..., min_length=1),
    quadrant: int = Form(..., ge=0, le=3),
  ):
    record = resolved_store.add_example(text=text, quadrant=quadrant)
    return {
      "message": "Training example added.",
      "example": record,
    }

  @app.post("/retrain")
  def retrain_model(preserve_experience: bool = Form(True)):
    return resolved_ai_service.retrain(preserve_experience=preserve_experience)

  @app.post("/learn-feedback")
  def learn_from_feedback(
    task: str = Form(..., min_length=1),
    predicted_quadrant: int = Form(..., ge=0, le=3),
    correct_quadrant: int = Form(..., ge=0, le=3),
  ):
    return resolved_ai_service.learn_feedback(
      task,
      predicted_quadrant,
      correct_quadrant,
      source="feedback",
    )

  @app.post("/learn-ocr-feedback")
  def learn_from_ocr_feedback(request: OCRFeedbackRequest):
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
  def get_training_stats():
    return resolved_ai_service.get_training_stats()

  @app.delete("/training-data")
  def clear_training_data(keep_defaults: bool = Query(True)):
    records = resolved_store.clear(keep_defaults=keep_defaults)
    return {
      "message": "Training data cleared.",
      "remaining_examples": len(records),
    }

  @app.get("/examples/{quadrant}")
  def get_examples_by_quadrant(quadrant: int, limit: int = Query(10, ge=1, le=100)):
    if quadrant not in QUADRANT_NAMES:
      raise HTTPException(status_code=404, detail="Quadrant not found.")
    return {
      "quadrant": quadrant,
      "quadrant_name": QUADRANT_NAMES[quadrant],
      "examples": resolved_store.get_examples(quadrant, limit=limit),
    }

  @app.get("/capabilities")
  def get_capabilities():
    return resolved_ai_service.capabilities()

  @app.put("/providers/{provider_name}")
  def update_provider(
    provider_name: Literal["local_model", "tesseract"],
    request: ProviderStateRequest,
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
