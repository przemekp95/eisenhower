from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.knowledge_runtime import create_knowledge_runtime
from tests.test_api import FakeRagService


def test_knowledge_runtime_exposes_only_knowledge_readiness_liveness_and_metrics(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=True,
    rag_response_enabled=True,
  )
  client = TestClient(create_knowledge_runtime(settings=settings, rag_service=FakeRagService()))
  headers = {"Authorization": "Bearer test-api-token"}

  answer = client.post("/v2/knowledge/answer", json={"query": "Co jest kanoniczne?"}, headers=headers)
  search = client.post("/v2/knowledge/search", json={"query": "kanoniczne"}, headers=headers)

  assert answer.status_code == 200
  assert answer.json()["status"] == "answered"
  assert search.status_code == 200
  assert client.get("/health/live", headers=headers).status_code == 200
  assert client.get("/health/ready", headers=headers).status_code == 200
  assert client.get("/metrics", headers=headers).status_code == 200
  assert client.post("/v2/ai/analyze", json={"task": "hidden"}, headers=headers).status_code == 404
  assert client.get("/docs", headers=headers).status_code == 404
