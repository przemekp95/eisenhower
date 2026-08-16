from types import SimpleNamespace

import httpx

from scripts.run_retrieval_candidate import VllmScoreReranker


def test_candidate_runner_uses_authenticated_v1_score_contract():
  seen = []

  def handler(request: httpx.Request) -> httpx.Response:
    seen.append((request.url.path, request.headers.get("authorization")))
    if request.url.path == "/v1/models":
      return httpx.Response(200, json={"data": [{
        "id": "BAAI/bge-reranker-v2-m3@953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e",
        "max_model_len": 192,
      }]})
    if request.url.path == "/v1/score":
      return httpx.Response(200, json={"data": [{"index": 0, "score": 0.9}]})
    return httpx.Response(404)

  client = httpx.Client(transport=httpx.MockTransport(handler))
  reranker = VllmScoreReranker(
    "http://reranker:8000", "private-token", client=client
  )

  assert reranker.score("query", [SimpleNamespace(title="Title", text="Body")]) == [0.9]
  assert seen == [
    ("/v1/models", "Bearer private-token"),
    ("/v1/score", "Bearer private-token"),
  ]
