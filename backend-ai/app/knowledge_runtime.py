from __future__ import annotations

from .config import Settings, load_settings
from .main import create_app
from .rag.bootstrap import build_rag_service


class _KnowledgeOnlyClassifier:
  """Non-callable boundary object required by the shared RAG application."""

  local_model = None

  def classify_task(self, *_args, **_kwargs):
    raise RuntimeError("classifier is not available in the knowledge-only runtime")

  def capabilities(self):
    return {"classification": False}


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
  allowed_paths = {"/health/live", "/metrics", "/v2/knowledge/answer"}
  application.router.routes = [
    route for route in application.router.routes
    if getattr(route, "path", None) in allowed_paths
  ]
  application.title = "Eisenhower Knowledge Answer Runtime"
  return application


def from_environment():
  return create_knowledge_runtime()
