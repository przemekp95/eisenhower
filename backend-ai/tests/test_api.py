from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.local_model import LocalMiniLMClassifier, LocalPrediction, ModelNotReadyError, SimilarExample
from app.main import create_app
from app.service import QuadrantAIService
from app.store import TrainingStore


class FakeLocalModel:
  def __init__(self, *, ready: bool = True, fail_predict: bool = False, startup_error: Exception | None = None):
    self.ready = ready
    self.fail_predict = fail_predict
    self.startup_error = startup_error
    self.ensure_ready_calls: list[list[dict]] = []
    self.train_calls: list[list[dict]] = []
    self.predict_many_calls: list[tuple[list[str], int]] = []

  def ensure_ready(self, records):
    self.ensure_ready_calls.append(records)
    if self.startup_error is not None:
      raise self.startup_error
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

  def predict_many(self, tasks: list[str], limit: int = 3):
    self.predict_many_calls.append((list(tasks), limit))
    return [self.predict(task, limit=limit) for task in tasks]

  def explain(self, task: str, language: str = "en", prediction: LocalPrediction | None = None):
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


def build_client(
  tmp_path: Path,
  *,
  local_model: FakeLocalModel | None = None,
  tesseract_available: bool | None = None,
) -> TestClient:
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
  if tesseract_available is not None:
    service._tesseract_available = lambda: tesseract_available  # type: ignore[method-assign]
  return TestClient(create_app(settings=settings, store=store, ai_service=service))


def build_real_client(real_model_bundle, *, tesseract_available: bool | None = None) -> TestClient:
  settings = real_model_bundle["settings"]
  store = TrainingStore(settings.training_data_path)
  local_model = LocalMiniLMClassifier(settings=settings, encoder=real_model_bundle["encoder"])
  service = QuadrantAIService(
    settings=settings,
    store=store,
    local_model=local_model,
  )
  if tesseract_available is not None:
    service._tesseract_available = lambda: tesseract_available  # type: ignore[method-assign]
  return TestClient(create_app(settings=settings, store=store, ai_service=service))


def test_root_and_capabilities(real_model_bundle):
  client = build_real_client(real_model_bundle, tesseract_available=True)

  root = client.get("/")
  capabilities = client.get("/capabilities")

  assert root.status_code == 200
  assert capabilities.status_code == 200
  assert capabilities.json()["classification"] is True
  assert capabilities.json()["providers"]["local_model"] is True
  assert capabilities.json()["providers"]["ocr"] is True
  assert capabilities.json()["provider_controls"]["local_model"]["enabled"] is True


def test_capabilities_report_ocr_unavailable_without_host_tesseract(real_model_bundle):
  client = build_real_client(real_model_bundle, tesseract_available=False)

  capabilities = client.get("/capabilities")

  assert capabilities.status_code == 200
  assert capabilities.json()["providers"]["local_model"] is True
  assert capabilities.json()["providers"]["ocr"] is False
  assert capabilities.json()["provider_controls"]["tesseract"]["available"] is False
  assert capabilities.json()["provider_controls"]["tesseract"]["active"] is False


def test_cors_allows_local_frontend_origins(real_model_bundle):
  client = build_real_client(real_model_bundle)

  response = client.options(
    "/analyze-langchain",
    headers={
      "Origin": "http://127.0.0.1:5173",
      "Access-Control-Request-Method": "POST",
    },
  )

  assert response.status_code == 200
  assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"


def test_classify_and_langchain_analysis(real_model_bundle):
  client = build_real_client(real_model_bundle)

  classify = client.get("/classify", params={"title": "critical production incident"})
  analyze = client.post("/analyze-langchain", params={"task": "exercise twice a week", "language": "pl"})

  assert classify.status_code == 200
  assert classify.json()["quadrant"] == 0
  assert classify.json()["method"] == "local-minilm"
  assert analyze.status_code == 200
  assert analyze.json()["langchain_analysis"]["quadrant"] == 2
  assert analyze.json()["langchain_analysis"]["method"] == "local-analysis"
  assert analyze.json()["rag_classification"]["quadrant_name"] == "Deleguj"


def test_training_management_endpoints(real_model_bundle):
  client = build_real_client(real_model_bundle)

  add = client.post("/add-example", data={"text": "review invoices", "quadrant": 1})
  feedback = client.post(
    "/learn-feedback",
    data={
      "task": "exercise twice a week",
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
  assert retrain.json()["examples_seen"] >= len(real_model_bundle["records"])
  assert clear.json()["remaining_examples"] == 0


def test_ocr_feedback_endpoint_batches_examples_and_retrains(tmp_path: Path):
  local_model = FakeLocalModel()
  client = build_client(tmp_path, local_model=local_model)

  feedback = client.post(
    "/learn-ocr-feedback",
    json={
      "tasks": [
        {"task": "urgent outage", "quadrant": 0},
        {"task": "prepare roadmap", "quadrant": 2},
      ],
      "retrain": True,
    },
  )
  stats = client.get("/training-stats")

  assert feedback.status_code == 200
  assert feedback.json()["examples_added"] == 2
  assert feedback.json()["retrained"] is True
  assert feedback.json()["training"]["examples_seen"] == stats.json()["total_examples"]
  assert local_model.train_calls


def test_ocr_feedback_endpoint_rejects_empty_batches(tmp_path: Path):
  client = build_client(tmp_path)

  feedback = client.post("/learn-ocr-feedback", json={"tasks": []})

  assert feedback.status_code == 400
  assert feedback.json()["error"] == "At least one accepted OCR task is required."


def test_batch_and_extract_routes(real_model_bundle):
  client = build_real_client(real_model_bundle)

  batch = client.post("/batch-analyze", json={"tasks": ["critical production incident", "exercise twice a week"]})
  upload = client.post(
    "/extract-tasks-from-image",
    files={"file": ("tasks.txt", b"critical production incident\nexercise twice a week\n", "text/plain")},
  )

  assert batch.status_code == 200
  assert batch.json()["summary"]["total_tasks"] == 2
  assert upload.status_code == 200
  assert upload.json()["summary"]["total_tasks"] == 2
  assert upload.json()["ocr"]["method"] == "plain-text"
  assert upload.json()["classified_tasks"][0]["similar_examples_used"] >= 1
  assert upload.json()["classified_tasks"][0]["top_similar_examples"]


def test_provider_toggle_endpoint_disables_and_reenables_runtime_features(real_model_bundle):
  client = build_real_client(real_model_bundle)

  disable_local_model = client.put("/providers/local_model", json={"enabled": False})
  disabled_classify = client.get("/classify", params={"title": "critical production incident"})
  disable_tesseract = client.put("/providers/tesseract", json={"enabled": False})
  disabled_image_upload = client.post(
    "/extract-tasks-from-image",
    files={"file": ("tasks.png", b"fake-image", "image/png")},
  )
  text_upload = client.post(
    "/extract-tasks-from-image",
    files={"file": ("tasks.txt", b"critical production incident\n", "text/plain")},
  )
  enable_local_model = client.put("/providers/local_model", json={"enabled": True})
  enabled_classify = client.get("/classify", params={"title": "critical production incident"})
  enable_tesseract = client.put("/providers/tesseract", json={"enabled": True})

  assert disable_local_model.status_code == 200
  assert disable_local_model.json()["enabled"] is False
  assert disable_local_model.json()["reason"] == "Disabled in AI management."
  assert disabled_classify.status_code == 503
  assert disabled_classify.json()["code"] == "provider_disabled"
  assert disable_tesseract.status_code == 200
  assert disabled_image_upload.status_code == 503
  assert disabled_image_upload.json()["code"] == "provider_disabled"
  assert text_upload.status_code == 503
  assert text_upload.json()["code"] == "provider_disabled"
  assert enable_local_model.status_code == 200
  assert enable_local_model.json()["active"] is True
  assert enabled_classify.status_code == 200
  assert enable_tesseract.status_code == 200


def test_error_shapes_are_json(real_model_bundle):
  client = build_real_client(real_model_bundle)

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


def test_capabilities_stay_available_when_startup_raises_generic_error(tmp_path: Path):
  client = build_client(tmp_path, local_model=FakeLocalModel(startup_error=RuntimeError("corrupt artifacts")))

  capabilities = client.get("/capabilities")
  stats = client.get("/training-stats")

  assert capabilities.status_code == 200
  assert capabilities.json()["providers"]["local_model"] is False
  assert capabilities.json()["provider_controls"]["local_model"]["available"] is False
  assert stats.status_code == 200
  assert stats.json()["model_ready"] is False
  assert stats.json()["model_error"] == "corrupt artifacts"
