from pathlib import Path
from datetime import datetime, timedelta, timezone
import math

from app.config import Settings
from app.local_model import (
  LocalMiniLMClassifier,
  ModelNotReadyError,
  clean_training_records,
  cosine_similarity,
  records_fingerprint,
  split_indices,
  three_way_split_indices,
)


class FakeEncoder:
  def __init__(self):
    self.calls: list[list[str]] = []

  def encode(
    self,
    texts: list[str],
    *,
    normalize_embeddings: bool = True,
    convert_to_numpy: bool = True,
    show_progress_bar: bool = False,
  ):
    del convert_to_numpy, show_progress_bar
    self.calls.append(list(texts))
    return [self._vectorize(text, normalize_embeddings=normalize_embeddings) for text in texts]

  def _vectorize(self, text: str, *, normalize_embeddings: bool) -> list[float]:
    vector = [0.0] * 384
    lowered = text.lower()
    for index, char in enumerate(lowered[:96]):
      vector[index % 384] += ((ord(char) % 31) + 1) / 31
    for index, token in enumerate(lowered.split()[:32]):
      vector[(index * 11) % 384] += len(token) / 10

    if normalize_embeddings:
      magnitude = math.sqrt(sum(value * value for value in vector))
      if magnitude:
        vector = [value / magnitude for value in vector]
    return vector


class ListWithToList:
  def __init__(self, values):
    self._values = values

  def tolist(self):
    return self._values


class FakeEncoderWithToList(FakeEncoder):
  def encode(
    self,
    texts: list[str],
    *,
    normalize_embeddings: bool = True,
    convert_to_numpy: bool = True,
    show_progress_bar: bool = False,
  ):
    return ListWithToList(
      [self._vectorize(text, normalize_embeddings=normalize_embeddings) for text in texts]
    )


class Fake256Encoder(FakeEncoder):
  def _vectorize(self, text: str, *, normalize_embeddings: bool) -> list[float]:
    base = super()._vectorize(text, normalize_embeddings=False)
    vector = base[:256]
    if normalize_embeddings:
      magnitude = math.sqrt(sum(value * value for value in vector))
      if magnitude:
        vector = [value / magnitude for value in vector]
    return vector


class FakeEncoderWithDimensionGetter(FakeEncoder):
  def __init__(self, dimension: int = 384):
    super().__init__()
    self.dimension = dimension

  def get_sentence_embedding_dimension(self) -> int:
    return self.dimension


def build_settings(tmp_path: Path) -> Settings:
  return Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    local_model_epochs=6,
    local_model_patience=2,
  )


def records():
  return [
    {"text": "urgent deadline today", "quadrant": 0, "source": "default"},
    {"text": "critical production incident", "quadrant": 0, "source": "default"},
    {"text": "reply to inbox", "quadrant": 1, "source": "default"},
    {"text": "book meeting room", "quadrant": 1, "source": "default"},
    {"text": "prepare strategic roadmap", "quadrant": 2, "source": "default"},
    {"text": "exercise twice a week", "quadrant": 2, "source": "default"},
    {"text": "scroll social media", "quadrant": 3, "source": "default"},
    {"text": "clean random screenshots", "quadrant": 3, "source": "default"},
  ]


def test_local_model_bootstraps_trains_and_predicts(tmp_path: Path):
  model = LocalMiniLMClassifier(settings=build_settings(tmp_path), encoder=FakeEncoder())

  model.ensure_ready(records())
  model.ensure_ready(records())
  prediction = model.predict("prepare strategic roadmap")
  explanation = model.explain("prepare strategic roadmap", language="pl")
  status = model.status()

  assert prediction.quadrant in {0, 1, 2, 3}
  assert prediction.confidence > 0
  assert model.head_path.exists()
  assert model.meta_path.exists()
  assert model.index_path.exists()
  assert model.current_pointer_path.exists()
  assert model.status()["generation_id"]
  assert explanation["method"] == "local-analysis"
  assert status["ready"] is True
  assert status["examples_seen"] == len(records())


def test_local_model_predict_reuses_query_embedding_and_supports_batch_predictions(tmp_path: Path):
  encoder = FakeEncoder()
  model = LocalMiniLMClassifier(settings=build_settings(tmp_path), encoder=encoder)

  model.train(records())
  encoder.calls.clear()

  single_prediction = model.predict("urgent deadline today", limit=0)
  batch_predictions = model.predict_many(
    ["urgent deadline today", "prepare strategic roadmap"],
    limit=0,
  )

  assert not single_prediction.similar_examples
  assert batch_predictions[0].quadrant == single_prediction.quadrant
  assert batch_predictions[1].confidence > 0
  assert all(prediction.similar_examples == [] for prediction in batch_predictions)
  assert encoder.calls == [
    ["urgent deadline today"],
    ["urgent deadline today", "prepare strategic roadmap"],
  ]
  assert not model.find_similar_examples("urgent deadline today", limit=0)


def test_local_model_batch_predict_rejects_empty_tasks(tmp_path: Path):
  model = LocalMiniLMClassifier(settings=build_settings(tmp_path), encoder=FakeEncoder())
  model.train(records())

  try:
    model.predict_many(["urgent deadline today", "   "], limit=0)
  except ValueError as issue:
    assert str(issue) == "Task must not be empty."
  else:
    raise AssertionError("Expected ValueError")


def test_local_model_loads_existing_artifacts_without_retraining(tmp_path: Path):
  settings = build_settings(tmp_path)
  trainer = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())
  trainer.train(records())

  loader = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())
  loader.train = lambda _records: (_ for _ in ()).throw(AssertionError("train should not run"))  # type: ignore[method-assign]
  loader.ensure_ready(records())

  assert loader.status()["ready"] is True
  assert loader.predict("urgent deadline today").confidence > 0


def test_local_model_keeps_verified_incumbent_ready_when_training_data_becomes_stale(tmp_path: Path):
  settings = build_settings(tmp_path)
  trainer = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())
  trainer.train(records())
  changed_records = records() + [{"text": "new reviewed task", "quadrant": 2, "source": "feedback"}]

  loader = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())
  loader.train = lambda _records: (_ for _ in ()).throw(AssertionError("stale data must not replace incumbent"))  # type: ignore[method-assign]
  loader.ensure_ready(changed_records)

  assert loader.status()["ready"] is True
  assert loader.status()["data_stale"] is True
  assert loader.predict("urgent deadline today").confidence > 0


def test_local_model_marks_corrupt_artifacts_as_not_ready(tmp_path: Path):
  settings = build_settings(tmp_path)
  trainer = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())
  trainer.train(records())
  trainer.head_path.write_text("not a torch file", encoding="utf-8")

  model = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())

  try:
    model.ensure_ready(records())
  except ModelNotReadyError as issue:
    assert "checksum" in str(issue)
  else:
    raise AssertionError("Expected ModelNotReadyError")

  status = model.status()
  assert status["ready"] is False
  last_error = status["last_error"]
  assert isinstance(last_error, str)
  assert "checksum" in str(last_error)


def test_local_model_rejects_artifacts_for_different_encoder(tmp_path: Path):
  trainer_settings = build_settings(tmp_path)
  trainer = LocalMiniLMClassifier(settings=trainer_settings, encoder=FakeEncoder())
  trainer.train(records())

  loader_settings = Settings(
    training_data_path=trainer_settings.training_data_path,
    model_cache_dir=trainer_settings.model_cache_dir,
    local_model_name="sentence-transformers/all-MiniLM-L6-v2",
    local_model_epochs=6,
    local_model_patience=2,
  )
  loader = LocalMiniLMClassifier(settings=loader_settings, encoder=FakeEncoder())

  try:
    loader.ensure_ready(records())
  except ModelNotReadyError as issue:
    assert "different encoder" in str(issue)
  else:
    raise AssertionError("Expected ModelNotReadyError")

  assert loader.status()["ready"] is False


def test_local_model_rejects_artifacts_for_different_hidden_dim_and_reuses_cached_dim(tmp_path: Path):
  trainer_settings = build_settings(tmp_path)
  trainer = LocalMiniLMClassifier(settings=trainer_settings, encoder=FakeEncoder())
  trainer.train(records())

  loader_settings = Settings(
    training_data_path=trainer_settings.training_data_path,
    model_cache_dir=trainer_settings.model_cache_dir,
    local_model_hidden_dim=64,
    local_model_epochs=6,
    local_model_patience=2,
  )
  loader = LocalMiniLMClassifier(settings=loader_settings, encoder=FakeEncoder())

  try:
    loader.ensure_ready(records())
  except ModelNotReadyError as issue:
    assert "different hidden dimension" in str(issue)
  else:
    raise AssertionError("Expected ModelNotReadyError")

  warm_model = LocalMiniLMClassifier(settings=build_settings(tmp_path / "warm"), encoder=FakeEncoderWithToList())
  assert warm_model._resolve_embedding_dim() == 384
  assert warm_model._resolve_embedding_dim() == 384


def test_local_model_uses_encoder_dimension_getter_before_probe_encode(tmp_path: Path):
  encoder = FakeEncoderWithDimensionGetter(384)
  model = LocalMiniLMClassifier(settings=build_settings(tmp_path), encoder=encoder)

  assert model._resolve_embedding_dim() == 384
  assert model._resolve_embedding_dim() == 384
  assert not encoder.calls


def test_local_model_rejects_empty_training_set(tmp_path: Path):
  model = LocalMiniLMClassifier(settings=build_settings(tmp_path), encoder=FakeEncoder())

  try:
    model.train([])
  except ModelNotReadyError as issue:
    assert str(issue) == "No training examples available."
  else:
    raise AssertionError("Expected ModelNotReadyError")

  assert model.status()["ready"] is False
  try:
    model.predict("urgent deadline today")
  except ModelNotReadyError as issue:
    assert str(issue) == "No training examples available."
  else:
    raise AssertionError("Expected ModelNotReadyError")


def test_local_model_covers_empty_task_no_similar_examples_and_torch_fallback(tmp_path: Path, monkeypatch):
  settings = build_settings(tmp_path)
  model = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())
  model.train(records())

  try:
    model.predict("   ")
  except ValueError as issue:
    assert str(issue) == "Task must not be empty."
  else:
    raise AssertionError("Expected ValueError")

  model._index = {"items": [{"text": "zero", "quadrant": 0, "source": "default", "embedding": [0.0] * 384}]}
  explanation = model.explain("plain unique task", language="en")
  assert "did not find strongly similar examples" in explanation["reasoning"]

  loader = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())
  import torch

  original_load = torch.load
  calls = {"count": 0}

  def flaky_load(*args, **kwargs):
    calls["count"] += 1
    if calls["count"] == 1 and "weights_only" in kwargs:
      raise TypeError("weights_only unsupported")
    return original_load(*args, **kwargs)

  monkeypatch.setattr(torch, "load", flaky_load)
  loader.ensure_ready(records())
  assert calls["count"] >= 2
  assert loader.predict("urgent deadline today").confidence > 0


def test_local_model_covers_polish_without_examples_and_lazy_encoder_factory(tmp_path: Path, monkeypatch):
  settings = build_settings(tmp_path)
  model = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoderWithToList())
  model.train(records())
  model._index = {"items": [{"text": "zero", "quadrant": 0, "source": "default", "embedding": [0.0] * 384}]}

  polish_explanation = model.explain("unikalne zadanie", language="pl")
  assert "nie znalazł silnie podobnych przykładów" in polish_explanation["reasoning"]

  import sentence_transformers

  class FakeSentenceTransformer(FakeEncoderWithToList):
    def __init__(self, model_name: str, *, revision: str):
      super().__init__()
      self.model_name = model_name
      self.revision = revision

  monkeypatch.setattr(sentence_transformers, "SentenceTransformer", FakeSentenceTransformer)
  lazy_model = LocalMiniLMClassifier(settings=settings)
  embeddings = lazy_model._encode(["prepare roadmap"])
  lazy_explanation = lazy_model.explain("prepare roadmap", language="en") if lazy_model.status()["ready"] else None

  assert embeddings
  assert lazy_model._load_encoder().model_name == settings.local_model_name
  assert lazy_model._load_encoder().revision == settings.local_model_revision
  assert lazy_explanation is None


def test_local_model_covers_english_reasoning_with_examples(tmp_path: Path):
  model = LocalMiniLMClassifier(settings=build_settings(tmp_path), encoder=FakeEncoder())
  model.train(records())

  explanation = model.explain("urgent deadline today", language="en")

  assert "Closest training examples" in explanation["reasoning"]


def test_local_model_supports_non_default_embedding_dimension(tmp_path: Path):
  settings = build_settings(tmp_path)
  model = LocalMiniLMClassifier(settings=settings, encoder=Fake256Encoder())

  model.ensure_ready(records())
  prediction = model.predict("prepare strategic roadmap")

  assert prediction.confidence > 0
  assert model.status()["ready"] is True


def test_local_model_real_minilm_smoke_predicts_stable_examples(real_model_bundle):
  settings = real_model_bundle["settings"]
  model = LocalMiniLMClassifier(settings=settings, encoder=real_model_bundle["encoder"])

  model.ensure_ready(real_model_bundle["records"])
  urgent_prediction = model.predict("critical production incident")
  schedule_prediction = model.predict("exercise twice a week")

  assert urgent_prediction.quadrant == 0
  assert schedule_prediction.quadrant == 2
  assert urgent_prediction.confidence > 0
  assert schedule_prediction.confidence > 0


def test_split_indices_covers_seeded_stratified_validation_and_skip_paths():
  train, validation, skipped = split_indices([0, 0, 1, 1, 2, 2, 3, 3])
  assert skipped is False
  assert len(train) == 4
  assert len(validation) == 4
  assert {index // 2 for index in validation} == {0, 1, 2, 3}
  assert (train, validation, skipped) == split_indices([0, 0, 1, 1, 2, 2, 3, 3])

  train_sparse, validation_sparse, skipped_sparse = split_indices([0, 0, 1, 2, 2, 3, 3, 3])
  assert train_sparse == list(range(8))
  assert not validation_sparse
  assert skipped_sparse is True

  train_small, validation_small, skipped_small = split_indices([0, 1, 2])
  assert train_small == [0, 1, 2]
  assert not validation_small
  assert skipped_small is True

  assert split_indices([0, 0, 0, 0, 0, 0, 0, 0])[2] is False
  assert split_indices([0, 0, 0, 0, 0, 0, 0, 0])[1]

  assert split_indices([0, 0, 0, 0, 0, 0, 0, 1])[2] is True
  assert not split_indices([0, 0, 0, 0, 0, 0, 0, 1])[1]

  assert cosine_similarity([], [1.0, 0.0]) == 0.0


def test_three_way_split_keeps_stopping_and_calibration_disjoint():
  labels = [class_id for class_id in range(4) for _ in range(5)]

  fit, stopping, calibration, skipped = three_way_split_indices(labels, seed=17)

  assert skipped is False
  assert set(fit).isdisjoint(stopping)
  assert set(fit).isdisjoint(calibration)
  assert set(stopping).isdisjoint(calibration)
  assert sorted(fit + stopping + calibration) == list(range(len(labels)))
  assert {labels[index] for index in stopping} == {0, 1, 2, 3}
  assert {labels[index] for index in calibration} == {0, 1, 2, 3}


def test_training_cleanup_quarantines_pending_and_conflicting_feedback():
  candidates = records() + [
    {"text": "  urgent deadline today  ", "quadrant": 0, "source": "feedback"},
    {"text": "conflicting label", "quadrant": 0, "source": "feedback"},
    {"text": "CONFLICTING   LABEL", "quadrant": 3, "source": "feedback"},
    {"text": "auto accepted OCR", "quadrant": 1, "source": "ocr-feedback", "training_status": "pending_review"},
  ]

  cleaned = clean_training_records(candidates)

  assert len(cleaned) == len(records())
  assert all(record["text"] not in {"conflicting label", "auto accepted OCR"} for record in cleaned)
  assert records_fingerprint(cleaned) == records_fingerprint(list(reversed(cleaned)))


def test_rejected_candidate_preserves_incumbent_artifact(tmp_path: Path):
  initial_settings = build_settings(tmp_path)
  incumbent = LocalMiniLMClassifier(settings=initial_settings, encoder=FakeEncoder())
  incumbent.train(records())
  original_head = incumbent.head_path.read_bytes()
  original_pointer = incumbent.current_pointer_path.read_bytes()

  evaluation_path = tmp_path / "evaluation.json"
  evaluation_examples = [
    {"id": f"en-{quadrant}", "language": "en", "text": f"evaluation task {quadrant}", "quadrant": quadrant}
    for quadrant in range(4)
  ] + [
    {"id": f"pl-{quadrant}", "language": "pl", "text": f"zadanie oceny {quadrant}", "quadrant": quadrant}
    for quadrant in range(4)
  ]
  import json
  evaluation_path.write_text(json.dumps({"name": "strict-eval", "examples": evaluation_examples}), encoding="utf-8")
  gated_settings = Settings(
    training_data_path=initial_settings.training_data_path,
    model_cache_dir=initial_settings.model_cache_dir,
    evaluation_data_path=evaluation_path,
    local_model_epochs=6,
    local_model_patience=2,
    local_model_minimum_macro_f1=1.0,
  )
  model = LocalMiniLMClassifier(settings=gated_settings, encoder=FakeEncoder())
  model.ensure_ready(records())

  result = model.train(records())

  assert result["promoted"] is False
  assert result["quality_gate"]["gate"]["passed"] is False
  assert model.head_path.read_bytes() == original_head
  assert model.current_pointer_path.read_bytes() == original_pointer
  assert model.status()["ready"] is True


def test_worker_refreshes_atomically_to_generation_promoted_by_another_worker(tmp_path: Path):
  settings = build_settings(tmp_path)
  worker_one = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())
  worker_one.train(records())
  worker_two = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())
  worker_two.ensure_ready(records())
  first_generation = worker_two.status()["generation_id"]

  worker_one.train(records())
  second_generation = worker_one.status()["generation_id"]
  worker_two.predict("urgent deadline today")

  assert second_generation != first_generation
  assert worker_two.status()["generation_id"] == second_generation


def test_required_evaluation_missing_fails_closed_without_writing_artifact(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    evaluation_data_path=tmp_path / "missing-evaluation.json",
    local_model_require_evaluation=True,
    local_model_epochs=6,
    local_model_patience=2,
  )
  model = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())

  try:
    model.train(records())
  except ModelNotReadyError as issue:
    assert "Required evaluation dataset" in str(issue)
  else:
    raise AssertionError("Missing required evaluation must block promotion")

  assert model.current_pointer_path.exists() is False


def test_time_bounded_owner_approval_can_replace_missing_human_evaluation(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    evaluation_data_path=tmp_path / "missing-evaluation.json",
    local_model_require_evaluation=True,
    local_model_owner_approval_bypass=True,
    local_model_owner_approval_valid_until=(
      datetime.now(timezone.utc) + timedelta(hours=1)
    ).isoformat(),
    local_model_epochs=6,
    local_model_patience=2,
  )
  model = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())

  result = model.train(records())

  assert result["promoted"] is True
  assert result["quality_gate"]["gate"]["passed"] is True
  assert result["quality_gate"]["gate"]["mode"] == "time_bounded_owner_approval"
  assert model.predict("urgent deadline today").quadrant in {0, 1, 2, 3}


def test_expired_owner_approval_blocks_classifier_at_request_time(tmp_path: Path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    evaluation_data_path=tmp_path / "missing-evaluation.json",
    local_model_require_evaluation=True,
    local_model_owner_approval_bypass=True,
    local_model_owner_approval_valid_until=(
      datetime.now(timezone.utc) + timedelta(hours=1)
    ).isoformat(),
    local_model_epochs=6,
    local_model_patience=2,
  )
  model = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())
  model.train(records())
  object.__setattr__(
    settings,
    "local_model_owner_approval_valid_until",
    (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(),
  )

  try:
    model.predict("urgent deadline today")
  except ModelNotReadyError as issue:
    assert "Owner approval expired" in str(issue)
  else:
    raise AssertionError("Expired owner approval must fail closed at request time")


def test_production_profile_rejects_self_declared_development_evaluation(tmp_path: Path):
  evaluation_path = tmp_path / "evaluation.json"
  import json
  evaluation_path.write_text(
    json.dumps(
      {
        "name": "development-only",
        "governance": {"status": "development", "frozen": True},
        "examples": [
          {
            "id": f"{language}-{quadrant}",
            "language": language,
            "text": f"evaluation {language} {quadrant}",
            "quadrant": quadrant,
          }
          for language in ("en", "pl")
          for quadrant in range(4)
        ],
      }
    ),
    encoding="utf-8",
  )
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    evaluation_data_path=evaluation_path,
    local_model_require_evaluation=True,
    local_model_evaluation_profile="production",
    local_model_epochs=6,
    local_model_patience=2,
  )
  model = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())

  try:
    model.train(records())
  except ModelNotReadyError as issue:
    assert "quality gate" in str(issue)
  else:
    raise AssertionError("Development evaluation must not promote production artifacts")
