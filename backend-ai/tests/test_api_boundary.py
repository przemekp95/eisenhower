from dataclasses import replace

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


def test_boundary_routes_memory_to_classifier_and_forwards_idempotency_key(tmp_path):
  observed = []

  def handler(request: httpx.Request):
    observed.append(request)
    return httpx.Response(200, json={"status": "active"})

  app = create_boundary_app(
    settings=settings(tmp_path),
    classifier_url="http://classifier-service:8000",
    knowledge_url="http://knowledge-service:8000",
    allowed_upstream_hosts=("classifier-service", "knowledge-service"),
    client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
  )
  client = TestClient(app)
  headers = {
    "Authorization": "Bearer user-token",
    "Origin": "https://app.example",
    "Idempotency-Key": "memory-confirm-1",
  }

  response = client.post(
    "/v2/memory/confirm",
    json={"intent": {"action": "delete"}, "receipt": {}},
    headers=headers,
  )
  preflight = client.options(
    "/v2/memory/confirm",
    headers={
      "Origin": "https://app.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
    },
  )

  assert response.status_code == 200
  assert observed[0].url.host == "classifier-service"
  assert observed[0].headers["idempotency-key"] == "memory-confirm-1"
  assert preflight.status_code == 200
  assert "idempotency-key" in preflight.headers["access-control-allow-headers"].lower()


def test_boundary_aggregates_classifier_and_knowledge_capabilities_fail_closed(tmp_path):
  observed = []

  def handler(request: httpx.Request):
    observed.append(request)
    if request.url.host == "classifier-service":
      return httpx.Response(200, json={
        "classification": True,
        "reasoned_local_analysis": True,
        "knowledge_retrieval": False,
        "retrieval_augmented_generation": False,
        "local_similar_examples": True,
        "ocr": True,
        "batch_analysis": True,
        "memory_write": False,
        "memory_retrieval": False,
        "memory_response": False,
      })
    return httpx.Response(200, json={
      "classification": False,
      "reasoned_local_analysis": False,
      "knowledge_retrieval": True,
      "retrieval_augmented_generation": True,
      "local_similar_examples": False,
      "ocr": False,
      "batch_analysis": False,
      "memory_write": False,
      "memory_retrieval": False,
      "memory_response": False,
    })

  app = create_boundary_app(
    settings=settings(tmp_path),
    classifier_url="http://classifier-service:8000",
    knowledge_url="http://knowledge-service:8000",
    allowed_upstream_hosts=("classifier-service", "knowledge-service"),
    client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
  )
  headers = {"Authorization": "Bearer user-token", "Origin": "https://app.example"}

  response = TestClient(app).get("/capabilities", headers=headers)

  assert response.status_code == 200
  assert response.json() == {
    "classification": True,
    "reasoned_local_analysis": True,
    "knowledge_retrieval": True,
    "retrieval_augmented_generation": True,
    "local_similar_examples": True,
    "ocr": True,
    "batch_analysis": True,
    "memory_write": False,
    "memory_retrieval": False,
    "memory_response": False,
  }
  assert [request.url.host for request in observed] == [
    "classifier-service",
    "knowledge-service",
  ]
  assert all(request.headers["authorization"] == "Bearer user-token" for request in observed)
  assert all(request.headers["origin"] == "https://app.example" for request in observed)


def test_boundary_metrics_expose_the_exact_release_sha_without_probing_optional_ai(tmp_path):
  release_sha = "a" * 40
  calls = []
  app = create_boundary_app(
    settings=replace(settings(tmp_path), release_sha=release_sha),
    classifier_url="http://classifier-service:8000",
    knowledge_url="http://knowledge-service:8000",
    allowed_upstream_hosts=("classifier-service", "knowledge-service"),
    client=httpx.AsyncClient(transport=httpx.MockTransport(
      lambda request: calls.append(request) or httpx.Response(503)
    )),
  )

  response = TestClient(app).get("/metrics")

  assert response.status_code == 200
  assert f'eisenhower_release_info{{sha="{release_sha}"}} 1' in response.text
  assert "eisenhower_ai_boundary_info 1" in response.text
  assert calls == []


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
