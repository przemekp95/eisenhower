from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.local_model import LocalPrediction, ModelNotReadyError, SimilarExample
from app.main import create_app
from app.service import QuadrantAIService
from app.store import TrainingStore


class FakeLocalModel:
  def __init__(self, *, ready: bool = True, fail_predict: bool = False):
    self.ready = ready
    self.fail_predict = fail_predict
    self.ensure_ready_calls: list[list[dict]] = []
    self.train_calls: list[list[dict]] = []

  def ensure_ready(self, records):
    self.ensure_ready_calls.append(records)
    if not self.ready:
      raise ModelNotReadyError("Model bootstrap failed.")

  def status(self):
    return {
      "ready": self.ready,
      "name": "local-minilm-mlp",
      "encoder_name": "sentence-transformers/test-model",
      "artifact_path": "/tmp/local_minilm_head.pt",
      "index_path": "/tmp/local_minilm_index.json",
      "trained_at": "2026-03-09T00:00:00+00:00",
      "validation_skipped": True,
      "last_error": None if self.ready else "Model bootstrap failed.",
      "examples_seen": 8,
    }

  def predict(self, task: str, limit: int = 3):
    if self.fail_predict:
      raise ModelNotReadyError("Model not ready.")
    quadrant = 2 if "roadmap" in task else 0
    similar_examples = [
      SimilarExample(
        text="prepare strategic roadmap" if quadrant == 2 else "critical production incident",
        quadrant=quadrant,
        source="default",
        score=0.88,
      )
    ][:limit]
    return LocalPrediction(
      quadrant=quadrant,
      confidence=0.83,
      probabilities=[0.1, 0.12, 0.7, 0.08] if quadrant == 2 else [0.78, 0.1, 0.07, 0.05],
      similar_examples=similar_examples,
    )

  def explain(self, task: str, language: str = "en"):
    quadrant = 2 if "roadmap" in task else 0
    return {
      "quadrant": quadrant,
      "quadrant_name": "Deleguj" if language == "pl" and quadrant == 2 else "Delegate",
      "confidence": 0.83,
      "reasoning": "Kwadrant „Deleguj” wynika z lokalnego modelu." if language == "pl" else "Local model explanation.",
      "method": "local-analysis",
      "similar_examples": [],
    }

  def train(self, records):
    self.train_calls.append(records)
    self.ready = True
    return {
      "artifact_path": "/tmp/local_minilm_head.pt",
      "trained_at": "2026-03-09T00:00:00+00:00",
      "validation_skipped": True,
      "examples_seen": len(records),
    }


def build_client(tmp_path: Path, *, local_model: FakeLocalModel | None = None) -> TestClient:
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
  )
  store = TrainingStore(tmp_path / "training.json")
  service = QuadrantAIService(
    settings=settings,
    store=store,
    local_model=local_model or FakeLocalModel(),
  )
  return TestClient(create_app(settings=settings, store=store, ai_service=service))


def test_root_and_capabilities(tmp_path: Path):
  client = build_client(tmp_path)

  root = client.get("/")
  capabilities = client.get("/capabilities")

  assert root.status_code == 200
  assert capabilities.status_code == 200
  assert capabilities.json()["classification"] is True
  assert capabilities.json()["providers"]["local_model"] is True
  assert capabilities.json()["providers"]["ocr"] is True


def test_cors_allows_local_frontend_origins(tmp_path: Path):
  client = build_client(tmp_path)

  response = client.options(
    "/analyze-langchain",
    headers={
      "Origin": "http://127.0.0.1:5173",
      "Access-Control-Request-Method": "POST",
    },
  )

  assert response.status_code == 200
  assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"


def test_classify_and_langchain_analysis(tmp_path: Path):
  client = build_client(tmp_path)

  classify = client.get("/classify", params={"title": "urgent client deadline"})
  analyze = client.post("/analyze-langchain", params={"task": "prepare roadmap", "language": "pl"})

  assert classify.status_code == 200
  assert classify.json()["quadrant"] == 0
  assert classify.json()["method"] == "local-minilm"
  assert analyze.status_code == 200
  assert analyze.json()["langchain_analysis"]["quadrant"] == 2
  assert analyze.json()["langchain_analysis"]["method"] == "local-analysis"
  assert analyze.json()["rag_classification"]["quadrant_name"] == "Deleguj"


def test_training_management_endpoints(tmp_path: Path):
  local_model = FakeLocalModel()
  client = build_client(tmp_path, local_model=local_model)

  add = client.post("/add-example", data={"text": "review invoices", "quadrant": 1})
  feedback = client.post(
    "/learn-feedback",
    data={
      "task": "prepare roadmap",
      "predicted_quadrant": 1,
      "correct_quadrant": 2,
    },
  )
  stats = client.get("/training-stats")
  examples = client.get("/examples/2", params={"limit": 5})
  retrain = client.post("/retrain", data={"preserve_experience": "false"})
  clear = client.delete("/training-data", params={"keep_defaults": "false"})

  assert add.status_code == 200
  assert feedback.status_code == 200
  assert stats.status_code == 200
  assert stats.json()["model_ready"] is True
  assert examples.status_code == 200
  assert retrain.json()["preserve_experience"] is False
  assert retrain.json()["preserve_experience_deprecated"] is True
  assert local_model.train_calls
  assert clear.json()["remaining_examples"] == 0


def test_batch_and_extract_routes(tmp_path: Path):
  client = build_client(tmp_path)

  batch = client.post("/batch-analyze", json={"tasks": ["urgent outage", "prepare roadmap"]})
  upload = client.post(
    "/extract-tasks-from-image",
    files={"file": ("tasks.txt", b"urgent outage\nprepare roadmap\n", "text/plain")},
  )

  assert batch.status_code == 200
  assert batch.json()["summary"]["total_tasks"] == 2
  assert upload.status_code == 200
  assert upload.json()["summary"]["total_tasks"] == 2
  assert upload.json()["ocr"]["method"] == "plain-text"


def test_error_shapes_are_json(tmp_path: Path):
  client = build_client(tmp_path)

  missing = client.post("/batch-analyze", json={"tasks": []})
  quadrant = client.get("/examples/9")

  assert missing.status_code == 400
  assert missing.json()["error"] == "At least one task is required."
  assert quadrant.status_code == 404
  assert quadrant.json()["error"] == "Quadrant not found."


def test_model_not_ready_errors_return_503(tmp_path: Path):
  client = build_client(tmp_path, local_model=FakeLocalModel(fail_predict=True))

  response = client.get("/classify", params={"title": "urgent client deadline"})

  assert response.status_code == 503
  assert response.json()["code"] == "model_not_ready"
