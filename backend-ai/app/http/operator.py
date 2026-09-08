from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request

from ..device import get_device
from .composition import AppDependencies
from .middleware import require_operator
from .schemas import ProviderStateRequest


def create_operator_router(deps: AppDependencies) -> APIRouter:
  router = APIRouter()
  settings = deps.settings
  ai_service = deps.ai_service
  rag_service = deps.rag_service
  response_canary_router = deps.response_canary_router

  def require_management_enabled() -> None:
    if not settings.ai_management_enabled:
      raise HTTPException(
        status_code=403,
        detail="Training management is disabled in this environment.",
      )

  @router.get("/capabilities")
  def get_capabilities(request: Request):
    caps = ai_service.capabilities()
    principal = request.state.principal
    tenant_enabled = (
      not settings.rag_allowed_tenants
      or principal.tenant_id in settings.rag_allowed_tenants
    )
    user_enabled = (
      (settings.app_env != "production" and not settings.rag_response_allowed_users)
      or principal.user_id in settings.rag_response_allowed_users
    )
    retrieval_available = bool(
      rag_service is not None
      and settings.rag_retrieval_enabled
      and tenant_enabled
    )
    generation_available = bool(
      retrieval_available
      and settings.rag_generation_enabled
      and getattr(rag_service, "generation_enabled", True)
    )
    response_available = bool(
      generation_available
      and settings.rag_response_enabled
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
      "memory_write": settings.memory_write_enabled,
      "memory_retrieval": settings.memory_retrieval_enabled,
      "memory_response": settings.memory_response_enabled,
    }

  @router.get("/operator/capabilities")
  def get_operator_capabilities(_operator: None = Depends(require_operator)):
    caps = ai_service.capabilities()
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
      "accelerated": device.type != "cpu",
    }
    return caps

  @router.put("/providers/{provider_name}")
  def update_provider(
    provider_name: Literal["local_model", "tesseract"],
    request: ProviderStateRequest,
    _operator: None = Depends(require_operator),
  ):
    require_management_enabled()
    return ai_service.set_provider_enabled(provider_name, request.enabled)

  return router
