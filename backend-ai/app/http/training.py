from __future__ import annotations

from fastapi import APIRouter, Depends, Form, HTTPException, Query

from ..defaults import QUADRANT_NAMES
from .composition import AppDependencies
from .middleware import require_operator
from .schemas import OCRFeedbackRequest


def create_training_router(deps: AppDependencies) -> APIRouter:
  router = APIRouter()
  settings = deps.settings
  store = deps.store
  ai_service = deps.ai_service

  def require_management_enabled() -> None:
    if not settings.ai_management_enabled:
      raise HTTPException(
        status_code=403,
        detail="Training management is disabled in this environment.",
      )

  @router.post("/add-example")
  def add_training_example(
    text: str = Form(..., min_length=1),
    quadrant: int = Form(..., ge=0, le=3),
    _operator: None = Depends(require_operator),
  ):
    require_management_enabled()
    record = store.add_example(text=text, quadrant=quadrant)
    return {
      "message": "Training example added.",
      "example": record,
    }

  @router.post("/retrain")
  def retrain_model(
    preserve_experience: bool = Form(True),
    _operator: None = Depends(require_operator),
  ):
    require_management_enabled()
    return ai_service.retrain(preserve_experience=preserve_experience)

  @router.post("/learn-feedback")
  def learn_from_feedback(
    task: str = Form(..., min_length=1),
    predicted_quadrant: int = Form(..., ge=0, le=3),
    correct_quadrant: int = Form(..., ge=0, le=3),
    _operator: None = Depends(require_operator),
  ):
    require_management_enabled()
    return ai_service.learn_feedback(
      task,
      predicted_quadrant,
      correct_quadrant,
      source="feedback",
    )

  @router.post("/learn-ocr-feedback")
  def learn_from_ocr_feedback(
    request: OCRFeedbackRequest,
    _operator: None = Depends(require_operator),
  ):
    require_management_enabled()
    if not request.tasks:
      raise HTTPException(status_code=400, detail="At least one accepted OCR task is required.")
    return ai_service.learn_feedback_batch(
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

  @router.get("/training-stats")
  def get_training_stats(_operator: None = Depends(require_operator)):
    return ai_service.get_training_stats()

  @router.delete("/training-data")
  def clear_training_data(
    keep_defaults: bool = Query(True),
    _operator: None = Depends(require_operator),
  ):
    require_management_enabled()
    records = store.clear(keep_defaults=keep_defaults)
    return {
      "message": "Training data cleared.",
      "remaining_examples": len(records),
    }

  @router.get("/examples/{quadrant}")
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
      "examples": store.get_examples(quadrant, limit=limit),
    }

  return router
