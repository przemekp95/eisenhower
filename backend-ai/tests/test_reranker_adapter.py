import json

import httpx
import pytest

from app.rag.hybrid import PrivateVllmReranker, RerankerUnavailable
from app.rag.models import RetrievalHit


MODEL_ID = "BAAI/bge-reranker-v2-m3@953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"


def hit(index: int) -> RetrievalHit:
  return RetrievalHit(
    chunk_id=f"chunk-{index}",
    document_id=f"doc-{index}",
    text=f"body {index}",
    score=1.0 - (index / 100),
    source_uri=f"docs/{index}.md",
    title=f"Title {index}",
    tenant_id="tenant-a",
    project_id="project-a",
    embedding_version="minilm-v1",
    content_version="v1",
  )


def test_private_reranker_verifies_pinned_runtime_and_sends_authenticated_bounded_scores():
  requests: list[httpx.Request] = []

  def handler(request: httpx.Request) -> httpx.Response:
    requests.append(request)
    assert request.headers["authorization"] == "Bearer reranker-token"
    if request.url.path == "/v1/models":
      return httpx.Response(200, json={"data": [{"id": MODEL_ID, "max_model_len": 192}]})
    body = json.loads(request.content)
    assert body == {
      "model": MODEL_ID,
      "text_1": "owner approval",
      "text_2": ["Title 0\nbody 0", "Title 1\nbody 1"],
      "truncate_prompt_tokens": 192,
    }
    return httpx.Response(200, json={"data": [
      {"index": 1, "score": 0.8},
      {"index": 0, "score": 0.2},
    ]})

  adapter = PrivateVllmReranker(
    "http://reranker:8000",
    "reranker-token",
    allowed_hosts=("reranker",),
    client=httpx.Client(transport=httpx.MockTransport(handler)),
  )

  assert adapter.score("owner approval", (hit(0), hit(1))) == [0.2, 0.8]
  assert [request.url.path for request in requests] == ["/v1/models", "/score"]


@pytest.mark.parametrize("model", [
  {"id": "wrong-model", "max_model_len": 192},
  {"id": MODEL_ID, "max_model_len": 512},
])
def test_private_reranker_rejects_unqualified_runtime(model):
  client = httpx.Client(transport=httpx.MockTransport(
    lambda _request: httpx.Response(200, json={"data": [model]})
  ))

  with pytest.raises(ValueError, match="evaluated"):
    PrivateVllmReranker(
      "http://reranker:8000",
      "reranker-token",
      allowed_hosts=("reranker",),
      client=client,
    )


def test_private_reranker_maps_runtime_failures_without_dense_fallback():
  calls = 0

  def handler(_request: httpx.Request) -> httpx.Response:
    nonlocal calls
    calls += 1
    if calls == 1:
      return httpx.Response(200, json={"data": [{"id": MODEL_ID, "max_model_len": 192}]})
    raise httpx.ReadTimeout("unavailable")

  adapter = PrivateVllmReranker(
    "http://reranker:8000",
    "reranker-token",
    allowed_hosts=("reranker",),
    client=httpx.Client(transport=httpx.MockTransport(handler)),
  )

  with pytest.raises(RerankerUnavailable, match="request failed"):
    adapter.score("query", (hit(0),))
