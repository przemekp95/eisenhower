from __future__ import annotations

from fastapi import FastAPI

from ..audit import AuditSink
from ..auth import TokenVerifier
from ..config import Settings
from ..metrics import MetricsRegistry
from ..service import QuadrantAIService
from ..store import TrainingStore
from .analysis import create_analysis_router
from .composition import build_dependencies
from .errors import register_exception_handlers
from .health import create_health_router
from .internal import create_internal_router
from .knowledge import create_knowledge_router
from .middleware import register_middleware
from .ocr import create_ocr_router
from .operator import create_operator_router
from .training import create_training_router


def create_app(
  settings: Settings | None = None,
  store: TrainingStore | None = None,
  ai_service: QuadrantAIService | None = None,
  rag_service: object | None = None,
  token_verifier: TokenVerifier | None = None,
  metrics_registry: MetricsRegistry | None = None,
  audit_sink: AuditSink | None = None,
  memory_runtime: object | None = None,
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
    from ..memory.routes import create_memory_router

    app.include_router(create_memory_router(
      dependencies.memory_runtime,
      write_enabled=resolved_settings.memory_write_enabled,
      retrieval_enabled=resolved_settings.memory_retrieval_enabled,
      metrics=dependencies.metrics_registry,
    ))
  app.include_router(create_health_router(dependencies))
  app.include_router(create_analysis_router(dependencies))
  app.include_router(create_knowledge_router(dependencies))
  app.include_router(create_ocr_router(dependencies))
  app.include_router(create_internal_router(dependencies))
  app.include_router(create_training_router(dependencies))
  app.include_router(create_operator_router(dependencies))
  register_exception_handlers(app, dependencies)
  return app
