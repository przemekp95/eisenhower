from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile

from ..service import OCRImageRejectedError
from .composition import AppDependencies


MAX_UPLOAD_BYTES = 10 * 1024 * 1024


def create_ocr_router(deps: AppDependencies) -> APIRouter:
  router = APIRouter()
  ai_service = deps.ai_service

  @router.post("/extract-tasks-from-image")
  async def extract_tasks_from_image(file: UploadFile = File(...)):
    payload = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(payload) > MAX_UPLOAD_BYTES:
      raise HTTPException(status_code=413, detail="Upload exceeds the 10 MiB limit.")
    try:
      return ai_service.extract_tasks_from_image(
        file.filename or "upload",
        payload,
        file.content_type,
      )
    except OCRImageRejectedError as exception:
      raise HTTPException(status_code=exception.status_code, detail=exception.code) from exception

  return router
