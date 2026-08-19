from __future__ import annotations

from fastapi import HTTPException

from .config import Settings, load_settings
from .main import create_app
from .rag.bootstrap import build_rag_service


class _KnowledgeOnlyClassifier:
  """Non-callable boundary object required by the shared RAG application."""

  local_model = None

  def classify_task(self, *_args, **_kwargs):
    raise RuntimeError("classifier is not available in the knowledge-only runtime")

  def capabilities(self):
    return {
      "classification": False,
      "reasoned_local_analysis": False,
      "local_similar_examples": False,
      "ocr": False,
      "batch_analysis": False,
    }


def create_knowledge_runtime(
  *, settings: Settings | None = None, rag_service=None
):
  resolved_settings = settings or load_settings()
  classifier = _KnowledgeOnlyClassifier()
  if rag_service is None:
    if resolved_settings.rag_embedding_model_name is None:
      raise ValueError("Knowledge runtime requires an independent embedding model")
    rag_service = build_rag_service(resolved_settings, classifier)
  application = create_app(
    settings=resolved_settings,
    ai_service=classifier,
    rag_service=rag_service,
  )
  allowed_paths = {
    "/capabilities",
    "/health/live",
    "/metrics",
    "/v2/knowledge/search",
    "/v2/knowledge/answer",
  }
  application.router.routes = [
    route for route in application.router.routes
    if getattr(route, "path", None) in allowed_paths
  ]

  @application.get("/health/ready", include_in_schema=False)
  def knowledge_ready():
    status = (
      rag_service.generation_status()
      if hasattr(rag_service, "generation_status")
      else {"enabled": False, "state": "disabled", "failures": 0}
    )
    if status.get("enabled") and status.get("state") == "open":
      raise HTTPException(status_code=503, detail="Generation circuit is open.")
    return {"status": "ready", "optional_dependencies": {"generation": status}}

  application.title = "Eisenhower Knowledge Answer Runtime"
  return application


def from_environment():
  return create_knowledge_runtime()
