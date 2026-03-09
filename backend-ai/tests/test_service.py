from io import BytesIO
from pathlib import Path

from PIL import Image

from app.config import Settings
from app.local_model import LocalMiniLMClassifier, LocalPrediction, ModelNotReadyError, SimilarExample
from app.service import (
  ProviderDisabledError,
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
    self.predict_many_calls: list[tuple[list[str], int]] = []
    self.explain_calls: list[tuple[str, str, int | None]] = []

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

  def predict_many(self, tasks: list[str], limit: int = 3):
    self.predict_many_calls.append((list(tasks), limit))
    return [self.predict(task, limit=limit) for task in tasks]

  def explain(
    self,
    task: str,
    language: str = "en",
    prediction: LocalPrediction | None = None,
  ):
    self.explain_calls.append((task, language, prediction.quadrant if prediction is not None else None))
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


def build_real_service(real_model_bundle, *, ocr_runner=None):
  settings = real_model_bundle["settings"]
  store = TrainingStore(settings.training_data_path)
  local_model = LocalMiniLMClassifier(settings=settings, encoder=real_model_bundle["encoder"])
  return QuadrantAIService(
    settings=settings,
    store=store,
    local_model=local_model,
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


def test_service_initialization_capabilities_and_stats(real_model_bundle, monkeypatch):
  service = build_real_service(real_model_bundle)
  monkeypatch.setattr(service, "_tesseract_available", lambda: True)

  capabilities = service.capabilities()
  stats = service.get_training_stats()

  assert capabilities["providers"]["local_model"] is True
  assert capabilities["providers"]["tesseract"] is True
  assert capabilities["provider_controls"]["local_model"]["enabled"] is True
  assert capabilities["provider_controls"]["tesseract"]["active"] is True
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
  assert stats["model_ready"] is False
  assert service.capabilities()["providers"]["local_model"] is False


def test_service_records_unexpected_startup_errors_without_crashing(tmp_path: Path):
  class ExplodingLocalModel(FakeLocalModel):
    def ensure_ready(self, records):
      super().ensure_ready(records)
      raise RuntimeError("corrupt artifacts")

  service = build_service(tmp_path, local_model=ExplodingLocalModel())

  assert service.get_training_stats()["model_error"] == "corrupt artifacts"
  assert service.get_training_stats()["model_ready"] is False
  assert service.capabilities()["providers"]["local_model"] is False


def test_classify_analyze_and_batch_stay_local(real_model_bundle):
  service = build_real_service(real_model_bundle)

  classification = service.classify_task("critical production incident")
  analysis = service.analyze_with_reasoning("exercise twice a week", language="pl")
  batch = service.batch_analyze(["critical production incident", "exercise twice a week"])

  assert classification["method"] == "local-minilm"
  assert classification["quadrant"] == 0
  assert classification["similar_examples_used"] >= 1
  assert analysis["langchain_analysis"]["method"] == "local-analysis"
  assert analysis["rag_classification"]["quadrant_name"] == "Deleguj"
  assert batch["summary"]["total_tasks"] == 2
  assert batch["summary"]["methods"]["rag"]["quadrant_distribution"]["0"] == 1
  assert batch["summary"]["methods"]["rag"]["quadrant_distribution"]["2"] == 1


def test_service_can_toggle_providers_and_persist_runtime_state(real_model_bundle, monkeypatch):
  service = build_real_service(real_model_bundle)
  monkeypatch.setattr(service, "_tesseract_available", lambda: True)

  local_model_state = service.set_provider_enabled("local_model", False)
  tesseract_state = service.set_provider_enabled("tesseract", False)
  capabilities = service.capabilities()

  assert local_model_state["enabled"] is False
  assert local_model_state["active"] is False
  assert local_model_state["reason"] == "Disabled in AI management."
  assert tesseract_state["enabled"] is False
  assert capabilities["classification"] is False
  assert capabilities["providers"]["local_model"] is False
  assert capabilities["providers"]["tesseract"] is False
  assert capabilities["provider_controls"]["local_model"]["enabled"] is False
  assert capabilities["provider_controls"]["tesseract"]["enabled"] is False

  reloaded = build_real_service(real_model_bundle)
  monkeypatch.setattr(reloaded, "_tesseract_available", lambda: True)
  reloaded_flags = reloaded.capabilities()["provider_controls"]
  assert reloaded_flags["local_model"]["enabled"] is False
  assert reloaded_flags["tesseract"]["enabled"] is False

  restored_local_model = reloaded.set_provider_enabled("local_model", True)
  restored_tesseract = reloaded.set_provider_enabled("tesseract", True)
  assert restored_local_model["active"] is True
  assert restored_tesseract["active"] is True


def test_service_blocks_disabled_providers(real_model_bundle, monkeypatch):
  service = build_real_service(
    real_model_bundle,
    ocr_runner=lambda *_args, **_kwargs: "critical production incident",
  )
  monkeypatch.setattr(service, "_tesseract_available", lambda: True)

  service.set_provider_enabled("local_model", False)
  try:
    service.classify_task("critical production incident")
  except ProviderDisabledError as issue:
    assert str(issue) == "Local model provider is disabled."
  else:
    raise AssertionError("Expected the local model provider to be disabled.")

  service.set_provider_enabled("local_model", True)
  service.set_provider_enabled("tesseract", False)
  try:
    service.extract_tasks_from_image("tasks.png", png_payload(), "image/png")
  except ProviderDisabledError as issue:
    assert str(issue) == "Tesseract provider is disabled."
  else:
    raise AssertionError("Expected the Tesseract provider to be disabled.")

  text_upload = service.extract_tasks_from_image(
    "tasks.txt",
    b"critical production incident\n",
    "text/plain",
  )
  assert text_upload["ocr"]["method"] == "plain-text"


def test_extract_tasks_from_image_prefers_text_and_tesseract_and_filename(real_model_bundle, monkeypatch):
  service = build_real_service(
    real_model_bundle,
    ocr_runner=lambda *_args, **_kwargs: "critical production incident\nexercise twice a week",
  )

  text_upload = service.extract_tasks_from_image(
    "tasks.txt",
    b"critical production incident\nexercise twice a week\n",
    "text/plain",
  )
  assert text_upload["ocr"]["method"] == "plain-text"
  assert text_upload["summary"]["total_tasks"] == 2

  monkeypatch.setattr(service, "_tesseract_available", lambda: True)
  image_upload = service.extract_tasks_from_image("tasks.png", png_payload(), "image/png")
  assert image_upload["ocr"]["method"] == "tesseract"
  assert image_upload["summary"]["total_tasks"] == 2

  failing_service = build_real_service(
    real_model_bundle,
    ocr_runner=lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("ocr failed")),
  )
  monkeypatch.setattr(failing_service, "_tesseract_available", lambda: True)
  failed_image_upload = failing_service.extract_tasks_from_image("urgent-outage.png", png_payload(), "image/png")
  assert failed_image_upload["ocr"]["method"] == "filename-fallback"

  monkeypatch.setattr(service, "_tesseract_available", lambda: False)
  try:
    service.extract_tasks_from_image("urgent-outage.png", b"", "image/png")
  except ProviderDisabledError as issue:
    assert str(issue) == "Tesseract binary is not available."
  else:
    raise AssertionError("Expected unavailable Tesseract to block image OCR.")

  fallback_upload = service.extract_tasks_from_image("urgent-outage.bin", b"", "application/octet-stream")
  assert fallback_upload["ocr"]["method"] == "filename-fallback"
  assert fallback_upload["classified_tasks"][0]["text"] == "urgent outage"
  assert service._looks_like_image("tasks.png", None) is True
  assert service._looks_like_image("tasks.bin", None) is False


def test_extract_tasks_from_image_uses_batch_prediction_with_rag(tmp_path: Path):
  local_model = FakeLocalModel()
  service = build_service(tmp_path, local_model=local_model)

  upload = service.extract_tasks_from_image(
    "tasks.txt",
    b"critical production incident\nexercise twice a week\n",
    "text/plain",
  )

  assert upload["summary"]["total_tasks"] == 2
  assert upload["classified_tasks"][0]["similar_examples_used"] == 1
  assert upload["classified_tasks"][0]["top_similar_examples"][0]["text"] == "prepare strategic roadmap"
  assert local_model.predict_many_calls == [(["critical production incident", "exercise twice a week"], 3)]
  assert local_model.predict_calls == [("critical production incident", 3), ("exercise twice a week", 3)]


def test_learn_feedback_batch_can_retrain_after_saving_records(tmp_path: Path):
  local_model = FakeLocalModel()
  service = build_service(tmp_path, local_model=local_model)

  result = service.learn_feedback_batch(
    [
      {"task": "urgent outage", "predicted_quadrant": 0, "correct_quadrant": 0},
      {"task": "prepare roadmap", "predicted_quadrant": 2, "correct_quadrant": 2},
    ],
    source="ocr-feedback",
    retrain=True,
  )

  stats = service.get_training_stats()

  assert result["examples_added"] == 2
  assert result["retrained"] is True
  assert result["training"]["examples_seen"] == stats["total_examples"]
  assert local_model.train_calls
  assert stats["data_sources"]["ocr-feedback"] == 2


def test_batch_analyze_reuses_single_batch_prediction_for_both_methods(tmp_path: Path):
  local_model = FakeLocalModel()
  service = build_service(tmp_path, local_model=local_model)

  result = service.batch_analyze(["urgent outage", "prepare roadmap"])

  assert result["summary"]["total_tasks"] == 2
  assert local_model.predict_many_calls == [(["urgent outage", "prepare roadmap"], 3)]
  assert local_model.predict_calls == [("urgent outage", 3), ("prepare roadmap", 3)]
  assert local_model.explain_calls == [("urgent outage", "en", 0), ("prepare roadmap", "en", 2)]


def test_service_batch_prediction_falls_back_when_local_model_has_no_predict_many(tmp_path: Path):
  class LegacyLocalModel(FakeLocalModel):
    predict_many = None  # type: ignore[assignment]

  legacy_model = LegacyLocalModel()
  service = build_service(tmp_path, local_model=legacy_model)

  predictions = service._predict_many(["urgent outage", "prepare roadmap"], limit=0)

  assert [prediction.quadrant for prediction in predictions] == [0, 2]
  assert legacy_model.predict_calls == [("urgent outage", 0), ("prepare roadmap", 0)]


def test_service_wraps_unexpected_batch_prediction_errors(tmp_path: Path):
  class ExplodingBatchModel(FakeLocalModel):
    def predict_many(self, tasks: list[str], limit: int = 3):
      raise RuntimeError("batch offline")

  service = build_service(tmp_path, local_model=ExplodingBatchModel())

  try:
    service._predict_many(["urgent outage"], limit=0)
  except ModelNotReadyError as issue:
    assert str(issue) == "batch offline"
  else:
    raise AssertionError("Expected ModelNotReadyError for unexpected batch prediction failure.")

  assert service.get_training_stats()["model_error"] == "batch offline"


def test_service_preserves_model_not_ready_from_batch_prediction(tmp_path: Path):
  class BrokenBatchModel(FakeLocalModel):
    def predict_many(self, tasks: list[str], limit: int = 3):
      raise ModelNotReadyError("batch unavailable")

  service = build_service(tmp_path, local_model=BrokenBatchModel())

  try:
    service._predict_many(["urgent outage"], limit=0)
  except ModelNotReadyError as issue:
    assert str(issue) == "batch unavailable"
  else:
    raise AssertionError("Expected ModelNotReadyError for unavailable batch prediction.")


def test_retrain_passes_records_and_marks_preserve_flag_deprecated(real_model_bundle):
  service = build_real_service(real_model_bundle)

  result = service.retrain(preserve_experience=False)

  assert result["preserve_experience"] is False
  assert result["preserve_experience_deprecated"] is True
  assert result["examples_seen"] >= len(real_model_bundle["records"])


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


def test_service_rejects_unknown_provider_names(tmp_path: Path):
  service = build_service(tmp_path)

  try:
    service.set_provider_enabled("vision", True)
  except ValueError as issue:
    assert str(issue) == "Unknown provider: vision"
  else:
    raise AssertionError("Expected an unknown provider name to raise ValueError.")

  try:
    service._provider_state("vision")
  except ValueError as issue:
    assert str(issue) == "Unknown provider: vision"
  else:
    raise AssertionError("Expected an unknown provider state lookup to raise ValueError.")


def test_service_raises_model_not_ready_when_provider_is_unavailable(tmp_path: Path):
  class BrokenLocalModel(FakeLocalModel):
    def ensure_ready(self, records):
      super().ensure_ready(records)
      raise RuntimeError("bootstrap failed")

  service = build_service(tmp_path, local_model=BrokenLocalModel())

  try:
    service.classify_task("urgent outage")
  except ModelNotReadyError as issue:
    assert str(issue) == "bootstrap failed"
  else:
    raise AssertionError("Expected ModelNotReadyError when the local model is unavailable.")
