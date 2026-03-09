from io import BytesIO
from pathlib import Path

from PIL import Image

from app.config import Settings
from app.local_model import LocalPrediction, ModelNotReadyError, SimilarExample
from app.service import (
  QuadrantAIService,
  cosine_similarity,
  lexical_similarity,
  normalize_extracted_tasks,
  quadrant_to_flags,
)
from app.store import TrainingStore


class FakeLocalModel:
  def __init__(self):
    self.ready = True
    self.ensure_ready_calls: list[list[dict]] = []
    self.train_calls: list[list[dict]] = []
    self.predict_calls: list[tuple[str, int]] = []

  def ensure_ready(self, records):
    self.ensure_ready_calls.append(records)

  def status(self):
    return {
      "ready": self.ready,
      "name": "local-minilm-mlp",
      "encoder_name": "sentence-transformers/test-model",
      "artifact_path": "/tmp/local_minilm_head.pt",
      "index_path": "/tmp/local_minilm_index.json",
      "trained_at": "2026-03-09T00:00:00+00:00",
      "validation_skipped": True,
      "last_error": None,
      "examples_seen": 8,
    }

  def predict(self, task: str, limit: int = 3):
    self.predict_calls.append((task, limit))
    return LocalPrediction(
      quadrant=0 if "urgent" in task else 2,
      confidence=0.81,
      probabilities=[0.81, 0.07, 0.08, 0.04] if "urgent" in task else [0.08, 0.11, 0.74, 0.07],
      similar_examples=[
        SimilarExample(
          text="critical production incident" if "urgent" in task else "prepare strategic roadmap",
          quadrant=0 if "urgent" in task else 2,
          source="default",
          score=0.86,
        )
      ][:limit],
    )

  def explain(self, task: str, language: str = "en"):
    return {
      "quadrant": 0 if "urgent" in task else 2,
      "quadrant_name": "Zrób teraz" if language == "pl" and "urgent" in task else "Deleguj",
      "confidence": 0.81,
      "reasoning": "Lokalny model wskazuje ten kwadrant." if language == "pl" else "Local model explanation.",
      "method": "local-analysis",
      "similar_examples": [],
    }

  def train(self, records):
    self.train_calls.append(records)
    return {
      "artifact_path": "/tmp/local_minilm_head.pt",
      "trained_at": "2026-03-09T00:00:00+00:00",
      "validation_skipped": False,
      "examples_seen": len(records),
    }


def build_service(tmp_path: Path, *, local_model=None, ocr_runner=None):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
  )
  store = TrainingStore(settings.training_data_path)
  return QuadrantAIService(
    settings=settings,
    store=store,
    local_model=local_model or FakeLocalModel(),
    ocr_runner=ocr_runner,
  )


def png_payload() -> bytes:
  image = Image.new("RGB", (4, 4), "white")
  buffer = BytesIO()
  image.save(buffer, format="PNG")
  return buffer.getvalue()


def test_service_helpers_cover_normalization_similarity_and_flags():
  assert quadrant_to_flags(0) == (True, True)
  assert quadrant_to_flags(1) == (True, False)
  assert quadrant_to_flags(2) == (False, True)
  assert quadrant_to_flags(3) == (False, False)

  normalized = normalize_extracted_tasks(
    [" urgent   outage ", "", "-urgent outage-", "Plan roadmap", "plan roadmap"]
  )
  assert normalized == ["urgent outage", "Plan roadmap"]

  assert cosine_similarity([0.0, 0.0], [1.0, 0.0]) == 0.0
  assert round(cosine_similarity([1.0, 1.0], [1.0, 1.0]), 4) == 1.0

  assert lexical_similarity("", "task") == 0.0
  assert lexical_similarity("pilne zadanie", "pilne nowe zadanie") > 0


def test_service_initialization_capabilities_and_stats(tmp_path: Path, monkeypatch):
  local_model = FakeLocalModel()
  service = build_service(tmp_path, local_model=local_model)
  monkeypatch.setattr(service, "_tesseract_available", lambda: True)

  capabilities = service.capabilities()
  stats = service.get_training_stats()

  assert local_model.ensure_ready_calls
  assert capabilities["providers"]["local_model"] is True
  assert capabilities["providers"]["tesseract"] is True
  assert stats["model_name"] == "local-minilm-mlp"
  assert stats["model_ready"] is True


def test_service_records_startup_error_when_model_bootstrap_fails(tmp_path: Path):
  class BrokenLocalModel(FakeLocalModel):
    def ensure_ready(self, records):
      super().ensure_ready(records)
      raise ModelNotReadyError("bootstrap failed")

  service = build_service(tmp_path, local_model=BrokenLocalModel())
  stats = service.get_training_stats()

  assert stats["model_error"] == "bootstrap failed"


def test_classify_analyze_and_batch_stay_local(tmp_path: Path):
  local_model = FakeLocalModel()
  service = build_service(tmp_path, local_model=local_model)

  classification = service.classify_task("urgent outage")
  analysis = service.analyze_with_reasoning("prepare roadmap", language="pl")
  batch = service.batch_analyze(["urgent outage", "prepare roadmap"])

  assert classification["method"] == "local-minilm"
  assert classification["quadrant"] == 0
  assert classification["similar_examples_used"] == 1
  assert analysis["langchain_analysis"]["method"] == "local-analysis"
  assert analysis["rag_classification"]["quadrant_name"] == "Deleguj"
  assert batch["summary"]["total_tasks"] == 2
  assert local_model.predict_calls[0] == ("urgent outage", 3)


def test_extract_tasks_from_image_prefers_text_and_tesseract_and_filename(tmp_path: Path, monkeypatch):
  local_model = FakeLocalModel()
  service = build_service(tmp_path, local_model=local_model, ocr_runner=lambda *_args, **_kwargs: "urgent outage\nprepare roadmap")

  text_upload = service.extract_tasks_from_image("tasks.txt", b"urgent outage\nprepare roadmap\n", "text/plain")
  assert text_upload["ocr"]["method"] == "plain-text"
  assert text_upload["summary"]["total_tasks"] == 2

  monkeypatch.setattr(service, "_tesseract_available", lambda: True)
  image_upload = service.extract_tasks_from_image("tasks.png", png_payload(), "image/png")
  assert image_upload["ocr"]["method"] == "tesseract"
  assert image_upload["summary"]["total_tasks"] == 2

  failing_service = build_service(
    tmp_path / "failure-case",
    local_model=FakeLocalModel(),
    ocr_runner=lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("ocr failed")),
  )
  monkeypatch.setattr(failing_service, "_tesseract_available", lambda: True)
  failed_image_upload = failing_service.extract_tasks_from_image("urgent-outage.png", png_payload(), "image/png")
  assert failed_image_upload["ocr"]["method"] == "filename-fallback"

  monkeypatch.setattr(service, "_tesseract_available", lambda: False)
  fallback_upload = service.extract_tasks_from_image("urgent-outage.png", b"", "image/png")
  assert fallback_upload["ocr"]["method"] == "filename-fallback"
  assert fallback_upload["classified_tasks"][0]["text"] == "urgent outage"
  assert service._looks_like_image("tasks.png", None) is True
  assert service._looks_like_image("tasks.bin", None) is False


def test_retrain_passes_records_and_marks_preserve_flag_deprecated(tmp_path: Path):
  local_model = FakeLocalModel()
  service = build_service(tmp_path, local_model=local_model)

  result = service.retrain(preserve_experience=False)

  assert local_model.train_calls
  assert result["preserve_experience"] is False
  assert result["preserve_experience_deprecated"] is True


def test_service_surfaces_model_not_ready(tmp_path: Path):
  class BrokenLocalModel(FakeLocalModel):
    def predict(self, task: str, limit: int = 3):
      raise ModelNotReadyError("model offline")

  service = build_service(tmp_path, local_model=BrokenLocalModel())

  try:
    service.classify_task("urgent outage")
  except ModelNotReadyError as issue:
    assert str(issue) == "model offline"
  else:
    raise AssertionError("Expected ModelNotReadyError")


def test_service_wraps_unexpected_prediction_errors(tmp_path: Path):
  class ExplodingLocalModel(FakeLocalModel):
    def predict(self, task: str, limit: int = 3):
      raise RuntimeError("bad weights")

  service = build_service(tmp_path, local_model=ExplodingLocalModel())

  try:
    service.classify_task("urgent outage")
  except ModelNotReadyError as issue:
    assert str(issue) == "bad weights"
  else:
    raise AssertionError("Expected ModelNotReadyError")

  assert service.get_training_stats()["model_error"] == "bad weights"
