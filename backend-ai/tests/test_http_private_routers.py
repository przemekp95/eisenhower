from __future__ import annotations

from pathlib import Path

from fastapi.routing import APIRoute

from app.config import Settings
from app.main import create_app


EXPECTED_OWNERS = {
  "/internal/webhooks/n8n/verify": "app.http.internal",
  "/internal/rag/ingestion/upsert": "app.http.internal",
  "/internal/rag/ingestion/tombstone": "app.http.internal",
  "/internal/rag/ingestion/extract": "app.http.internal",
  "/internal/rag/reindex": "app.http.internal",
  "/internal/rag/evaluations": "app.http.internal",
  "/add-example": "app.http.training",
  "/retrain": "app.http.training",
  "/learn-feedback": "app.http.training",
  "/learn-ocr-feedback": "app.http.training",
  "/training-stats": "app.http.training",
  "/training-data": "app.http.training",
  "/examples/{quadrant}": "app.http.training",
  "/capabilities": "app.http.operator",
  "/operator/capabilities": "app.http.operator",
  "/providers/{provider_name}": "app.http.operator",
}


def _all_api_routes(application) -> list[APIRoute]:
  routes = [route for route in application.routes if isinstance(route, APIRoute)]
  for included in application.routes:
    original_router = getattr(included, "original_router", None)
    if original_router is not None:
      routes.extend(route for route in original_router.routes if isinstance(route, APIRoute))
  return routes


def test_private_router_and_canonical_factory_modules_exist():
  from app.http.factory import create_app as canonical_factory
  from app.http.internal import create_internal_router
  from app.http.operator import create_operator_router
  from app.http.training import create_training_router

  assert all(callable(factory) for factory in (
    canonical_factory,
    create_internal_router,
    create_training_router,
    create_operator_router,
  ))


def test_remaining_paths_have_one_focused_owner(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
  )
  application = create_app(
    settings=settings,
    store=object(),
    ai_service=object(),
    token_verifier=object(),
    audit_sink=object(),
  )
  routes = _all_api_routes(application)

  for path, owner in EXPECTED_OWNERS.items():
    matching = [route for route in routes if route.path == path]
    assert len(matching) == 1
    assert matching[0].endpoint.__module__ == owner


def test_main_contains_only_compatibility_exports():
  import app.main as app_main

  source = Path(app_main.__file__).read_text(encoding="utf-8")
  assert "@app." not in source
  assert "build_dependencies(" not in source
  assert "from .http.factory import create_app" in source
