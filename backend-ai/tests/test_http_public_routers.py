from __future__ import annotations

from pathlib import Path

from fastapi.routing import APIRoute

from app.config import Settings
from app.main import create_app


EXPECTED_OWNERS = {
  "/": "app.http.health",
  "/metrics": "app.http.health",
  "/health/live": "app.http.health",
  "/health/ready": "app.http.health",
  "/v2/ai/analyze": "app.http.analysis",
  "/classify": "app.http.analysis",
  "/analyze": "app.http.analysis",
  "/analyze-langchain": "app.http.analysis",
  "/batch-analyze": "app.http.analysis",
  "/v2/knowledge/search": "app.http.knowledge",
  "/v2/knowledge/answer": "app.http.knowledge",
  "/extract-tasks-from-image": "app.http.ocr",
}


class _AiBoundary:
  def capabilities(self):
    return {"classification": True, "model": {"generation_id": "test"}}


class _Verifier:
  def verify(self, _token: str):
    raise AssertionError("route ownership must not authenticate")


class _Audit:
  def record(self, _event):
    raise AssertionError("route ownership must not audit")


def test_public_router_factories_exist():
  from app.http.analysis import create_analysis_router
  from app.http.health import create_health_router
  from app.http.knowledge import create_knowledge_router
  from app.http.ocr import create_ocr_router

  assert all(callable(factory) for factory in (
    create_health_router,
    create_analysis_router,
    create_knowledge_router,
    create_ocr_router,
  ))


def test_every_public_path_has_one_focused_router_owner(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
  )
  application = create_app(
    settings=settings,
    ai_service=_AiBoundary(),
    token_verifier=_Verifier(),
    audit_sink=_Audit(),
  )
  routes = [route for route in application.routes if isinstance(route, APIRoute)]
  for included in application.routes:
    original_router = getattr(included, "original_router", None)
    if original_router is not None:
      routes.extend(route for route in original_router.routes if isinstance(route, APIRoute))

  for path, owner in EXPECTED_OWNERS.items():
    matching = [route for route in routes if route.path == path]
    assert len(matching) == 1
    assert matching[0].endpoint.__module__ == owner
