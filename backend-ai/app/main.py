from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .config import Settings, load_settings
from .defaults import QUADRANT_NAMES
from .local_model import ModelNotReadyError
from .service import QuadrantAIService
from .store import TrainingStore


class BatchRequest(BaseModel):
  tasks: list[str] = Field(default_factory=list)


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
    resolved_store.add_example(text=task, quadrant=correct_quadrant, source="feedback")
    return {
      "message": "Feedback captured.",
      "predicted_quadrant": predicted_quadrant,
      "correct_quadrant": correct_quadrant,
    }

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

  @app.exception_handler(HTTPException)
  async def http_exception_handler(_request, exception: HTTPException):
    return JSONResponse(status_code=exception.status_code, content={"error": exception.detail})

  @app.exception_handler(ModelNotReadyError)
  async def model_not_ready_handler(_request, exception: ModelNotReadyError):
    return JSONResponse(status_code=503, content={"error": str(exception), "code": "model_not_ready"})

  return app
