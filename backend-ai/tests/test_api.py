from pathlib import Path

from fastapi.testclient import TestClient

from app.classifier import HeuristicClassifier
from app.config import Settings
from app.main import create_app
from app.store import TrainingStore


def build_client(tmp_path: Path) -> TestClient:
  app = create_app(
    settings=Settings(
      training_data_path=tmp_path / "training.json",
      model_cache_dir=tmp_path / "runtime",
    ),
    classifier=HeuristicClassifier(),
    store=TrainingStore(tmp_path / "training.json"),
  )
  return TestClient(app)


def test_root_and_capabilities(tmp_path: Path):
  client = build_client(tmp_path)

  root = client.get("/")
  capabilities = client.get("/capabilities")

  assert root.status_code == 200
  assert capabilities.status_code == 200
  assert capabilities.json()["classification"] is True


def test_classify_and_langchain_analysis(tmp_path: Path):
  client = build_client(tmp_path)

  classify = client.get("/classify", params={"title": "urgent client deadline"})
  analyze = client.post("/analyze-langchain", params={"task": "prepare roadmap"})

  assert classify.status_code == 200
  assert classify.json()["quadrant"] == 0
  assert analyze.status_code == 200
  assert analyze.json()["langchain_analysis"]["quadrant"] == 2


def test_training_management_endpoints(tmp_path: Path):
  client = build_client(tmp_path)

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
  assert examples.status_code == 200
  assert retrain.json()["preserve_experience"] is False
  assert clear.json()["remaining_examples"] == 0


def test_batch_and_extract_routes(tmp_path: Path):
  client = build_client(tmp_path)

  batch = client.post("/batch-analyze", json={"tasks": ["urgent outage", "exercise plan"]})
  upload = client.post(
    "/extract-tasks-from-image",
    files={"file": ("tasks.txt", b"urgent outage\nexercise plan\n", "text/plain")},
  )

  assert batch.status_code == 200
  assert batch.json()["summary"]["total_tasks"] == 2
  assert upload.status_code == 200
  assert upload.json()["summary"]["total_tasks"] == 2


def test_error_shapes_are_json(tmp_path: Path):
  client = build_client(tmp_path)

  missing = client.post("/batch-analyze", json={"tasks": []})
  quadrant = client.get("/examples/9")

  assert missing.status_code == 400
  assert missing.json()["error"] == "At least one task is required."
  assert quadrant.status_code == 404
  assert quadrant.json()["error"] == "Quadrant not found."
