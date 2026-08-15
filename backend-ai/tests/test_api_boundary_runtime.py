from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from app.api_boundary import BoundarySettings, PrivateKnowledgeProvider, create_boundary_app


ROOT = Path(__file__).parents[1]


def test_boundary_requirements_exclude_heavy_ai_and_storage_dependencies():
  requirements = ROOT.joinpath("requirements-boundary.txt").read_text(encoding="utf-8").lower()
  forbidden = (
    "torch",
    "torchvision",
    "sentence-transformers",
    "transformers",
    "docling",
    "unstructured",
    "onnx",
    "tesseract",
    "pillow",
    "pymongo",
    "qdrant",
    "llama-index",
  )
  assert all(package not in requirements for package in forbidden)


def test_dockerfile_has_a_dedicated_boundary_target_and_knowledge_dependencies():
  dockerfile = ROOT.joinpath("Dockerfile").read_text(encoding="utf-8")

  assert "FROM base AS dependencies-boundary" in dockerfile
  assert "COPY --chown=app:app requirements-boundary.txt" in dockerfile
  assert "FROM base AS api-boundary" in dockerfile
  assert 'app.api_boundary:from_environment' in dockerfile
  assert "requirements-knowledge.txt" in dockerfile
  assert "FROM production AS knowledge-production" in dockerfile


def test_boundary_forwards_the_original_bearer_and_does_not_forward_cookies():
  observed = {}

  def handler(request: httpx.Request) -> httpx.Response:
    observed["authorization"] = request.headers.get("authorization")
    observed["cookie"] = request.headers.get("cookie")
    return httpx.Response(200, json={"quadrant": "do"})

  provider = PrivateKnowledgeProvider(
    base_url="http://knowledge-service:8000",
    allowed_hosts=("knowledge-service",),
    transport=httpx.MockTransport(handler),
  )
  app = create_boundary_app(
    BoundarySettings(
      knowledge_base_url="http://knowledge-service:8000",
      knowledge_allowed_hosts=("knowledge-service",),
      cors_allow_origins=("https://eisenhower.example",),
    ),
    provider=provider,
  )

  with TestClient(app) as client:
    response = client.post(
      "/v2/ai/analyze",
      headers={
        "Authorization": "Bearer user-token",
        "Origin": "https://eisenhower.example",
        "Cookie": "session=must-not-cross",
      },
      json={"text": "important"},
    )

  assert response.status_code == 200
  assert observed == {"authorization": "Bearer user-token", "cookie": None}


def test_boundary_fails_closed_for_missing_bearer_untrusted_origin_and_unknown_route():
  provider = PrivateKnowledgeProvider(
    base_url="http://knowledge-service:8000",
    allowed_hosts=("knowledge-service",),
    transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})),
  )
  app = create_boundary_app(
    BoundarySettings(
      knowledge_base_url="http://knowledge-service:8000",
      knowledge_allowed_hosts=("knowledge-service",),
      cors_allow_origins=("https://eisenhower.example",),
    ),
    provider=provider,
  )

  with TestClient(app) as client:
    assert client.post("/v2/ai/analyze", json={"text": "x"}).status_code == 401
    assert client.post(
      "/v2/ai/analyze",
      headers={"Authorization": "Bearer token", "Origin": "https://evil.example"},
      json={"text": "x"},
    ).status_code == 403
    assert client.post(
      "/internal/rag/reindex",
      headers={"Authorization": "Bearer token"},
      json={},
    ).status_code == 404


def test_boundary_rejects_public_or_unallowlisted_private_provider_urls():
  for url, hosts in (
    ("https://example.com", ("example.com",)),
    ("http://knowledge-service:8000", ("other-service",)),
  ):
    try:
      PrivateKnowledgeProvider(base_url=url, allowed_hosts=hosts)
    except ValueError as error:
      assert "private" in str(error).lower() or "allow" in str(error).lower()
    else:
      raise AssertionError("unsafe provider URL was accepted")
