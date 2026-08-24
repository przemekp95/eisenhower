from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.auth import AuthPrincipal
from app.config import Settings
from app.main import create_app


def test_focused_http_registrars_exist():
  from app.http.errors import register_exception_handlers
  from app.http.middleware import register_middleware

  assert callable(register_middleware)
  assert callable(register_exception_handlers)


def test_effective_security_audit_handler_and_metrics_order(tmp_path: Path):
  calls: list[str] = []

  class Verifier:
    def verify(self, token: str):
      assert token == "operator-token"
      calls.append("authenticate")
      return AuthPrincipal(
        tenant_id="tenant-a",
        user_id="operator-a",
        roles=["operator"],
        scopes=["ai:operate"],
      )

  class Audit:
    def record(self, event):
      calls.append(f"audit:{event.outcome.value}")

  class Metrics:
    def set_release_sha(self, _release_sha: str):
      pass

    def observe_audit(self, outcome: str):
      calls.append(f"metrics:audit:{outcome}")

    def observe_http(self, method: str, route: str, status: int, _duration: float):
      calls.append(f"metrics:http:{method}:{route}:{status}")

  class AiService:
    def set_provider_enabled(self, provider_name: str, enabled: bool):
      calls.append("handler")
      return {"provider": provider_name, "enabled": enabled}

  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
  )
  application = create_app(
    settings=settings,
    ai_service=AiService(),
    token_verifier=Verifier(),
    metrics_registry=Metrics(),
    audit_sink=Audit(),
  )

  response = TestClient(application).put(
    "/providers/local_model",
    headers={
      "Authorization": "Bearer operator-token",
      "X-Request-ID": "middleware-order-request",
    },
    json={"enabled": False},
  )

  assert response.status_code == 200
  assert response.headers["x-request-id"] == "middleware-order-request"
  assert calls == [
    "authenticate",
    "audit:attempt",
    "metrics:audit:attempt",
    "handler",
    "audit:success",
    "metrics:audit:success",
    "metrics:http:PUT:/providers/{provider_name}:200",
  ]
