import httpx
from fastapi.testclient import TestClient

from app.api_boundary import create_boundary_app
from app.config import Settings


def settings(tmp_path):
  return Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    audit_database_path=tmp_path / "audit.sqlite3",
    audit_hmac_key="boundary-audit-key-that-is-long-enough",
    api_token="user-token",
    admin_token="admin-token",
    cors_allow_origins=("https://app.example",),
  )


def test_boundary_preserves_bearer_origin_and_routes_only_to_private_role_upstreams(tmp_path):
  observed = []

  def handler(request: httpx.Request):
    observed.append(request)
    if request.url.path == "/health/ready":
      return httpx.Response(200, json={"status": "ready"})
    return httpx.Response(200, json={"upstream": request.url.host, "path": request.url.path})

  app = create_boundary_app(
    settings=settings(tmp_path),
    classifier_url="http://classifier-service:8000",
    knowledge_url="http://knowledge-service:8000",
    allowed_upstream_hosts=("classifier-service", "knowledge-service"),
    client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
  )
  client = TestClient(app)
  headers = {"Authorization": "Bearer user-token", "Origin": "https://app.example"}

  classified = client.post("/classify", json={"title": "ship it"}, headers=headers)
  knowledge = client.post("/v2/knowledge/search", json={"query": "ports"}, headers=headers)

  assert classified.json()["upstream"] == "classifier-service"
  assert knowledge.json()["upstream"] == "knowledge-service"
  assert all(request.headers["authorization"] == "Bearer user-token" for request in observed)
  assert all(request.headers["origin"] == "https://app.example" for request in observed)


def test_boundary_rejects_untrusted_browser_mutation_before_proxying(tmp_path):
  calls = []
  app = create_boundary_app(
    settings=settings(tmp_path),
    classifier_url="http://classifier-service:8000",
    allowed_upstream_hosts=("classifier-service",),
    client=httpx.AsyncClient(transport=httpx.MockTransport(
      lambda request: calls.append(request) or httpx.Response(200)
    )),
  )

  response = TestClient(app).post(
    "/classify",
    json={"title": "ship it"},
    headers={"Authorization": "Bearer user-token", "Origin": "https://evil.example"},
  )

  assert response.status_code == 403
  assert calls == []


def test_boundary_does_not_follow_or_return_upstream_redirects_with_bearer_credentials(tmp_path):
  app = create_boundary_app(
    settings=settings(tmp_path),
    classifier_url="http://classifier-service:8000",
    allowed_upstream_hosts=("classifier-service",),
    client=httpx.AsyncClient(transport=httpx.MockTransport(
      lambda _request: httpx.Response(307, headers={"Location": "https://evil.example"})
    )),
  )

  response = TestClient(app).get(
    "/capabilities",
    headers={"Authorization": "Bearer user-token"},
  )

  assert response.status_code == 502
  assert "Location" not in response.headers
