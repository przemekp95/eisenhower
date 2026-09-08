from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from .composition import AppDependencies


def create_health_router(deps: AppDependencies) -> APIRouter:
  router = APIRouter()
  settings = deps.settings
  ai_service = deps.ai_service
  rag_service = deps.rag_service
  job_queue = deps.job_queue
  metrics = deps.metrics_registry

  @router.get("/")
  def root():
    return {"service": settings.app_name, "status": "ok"}

  @router.get("/metrics", include_in_schema=False)
  def prometheus_metrics():
    metrics.set_job_queue_enabled(job_queue is not None)
    if job_queue is not None:
      metrics.set_job_depths(job_queue.counts_by_status())
      metrics.set_job_depths_by_type(job_queue.counts_by_type_and_status())
      metrics.set_job_worker_heartbeat_age(job_queue.latest_worker_heartbeat_age_seconds())
    generation_status = (
      rag_service.generation_status()
      if rag_service is not None and hasattr(rag_service, "generation_status")
      else {"state": "disabled", "failures": 0}
    )
    metrics.set_generation_status(
      str(generation_status.get("state", "unknown")),
      failures=int(generation_status.get("failures", 0)),
    )
    return Response(content=metrics.render(), media_type="text/plain; version=0.0.4")

  @router.get("/health/live", include_in_schema=False)
  def health_live():
    return {"status": "ok"}

  @router.get("/health/ready", include_in_schema=False)
  def health_ready():
    capabilities = ai_service.capabilities()
    if not capabilities.get("classification"):
      raise HTTPException(status_code=503, detail="Local classifier is not ready.")
    generation_status = (
      rag_service.generation_status()
      if rag_service is not None and hasattr(rag_service, "generation_status")
      else {"enabled": False, "state": "disabled", "failures": 0}
    )
    return {
      "status": "ready",
      "generation_id": capabilities.get("model", {}).get("generation_id"),
      "optional_dependencies": {"generation": generation_status},
    }

  return router
