from pathlib import Path
import math

from app.config import Settings
from app.local_model import LocalMiniLMClassifier, ModelNotReadyError, cosine_similarity, split_indices


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
  assert explanation["method"] == "local-analysis"
  assert status["ready"] is True


def test_local_model_loads_existing_artifacts_without_retraining(tmp_path: Path):
  settings = build_settings(tmp_path)
  trainer = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())
  trainer.train(records())

  loader = LocalMiniLMClassifier(settings=settings, encoder=FakeEncoder())
  loader.train = lambda _records: (_ for _ in ()).throw(AssertionError("train should not run"))  # type: ignore[method-assign]
  loader.ensure_ready(records())

  assert loader.status()["ready"] is True
  assert loader.predict("urgent deadline today").confidence > 0


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
    def __init__(self, model_name: str):
      self.model_name = model_name

  monkeypatch.setattr(sentence_transformers, "SentenceTransformer", FakeSentenceTransformer)
  lazy_model = LocalMiniLMClassifier(settings=settings)
  embeddings = lazy_model._encode(["prepare roadmap"])
  lazy_explanation = lazy_model.explain("prepare roadmap", language="en") if lazy_model.status()["ready"] else None

  assert embeddings
  assert lazy_model._load_encoder().model_name == settings.local_model_name
  assert lazy_explanation is None


def test_local_model_covers_english_reasoning_with_examples(tmp_path: Path):
  model = LocalMiniLMClassifier(settings=build_settings(tmp_path), encoder=FakeEncoder())
  model.train(records())

  explanation = model.explain("urgent deadline today", language="en")

  assert "Closest training examples" in explanation["reasoning"]


def test_split_indices_covers_validation_and_skip_paths():
  train, validation, skipped = split_indices([0, 0, 1, 1, 2, 2, 3, 3])
  assert skipped is False
  assert train
  assert validation

  train_sparse, validation_sparse, skipped_sparse = split_indices([0, 0, 1, 2, 2, 3, 3, 3])
  assert train_sparse == list(range(8))
  assert validation_sparse == []
  assert skipped_sparse is True

  train_small, validation_small, skipped_small = split_indices([0, 1, 2])
  assert train_small == [0, 1, 2]
  assert validation_small == []
  assert skipped_small is True

  assert split_indices([0, 0, 0, 0, 0, 0, 0, 0])[2] is False
  assert split_indices([0, 0, 0, 0, 0, 0, 0, 0])[1]

  assert split_indices([0, 0, 0, 0, 0, 0, 0, 1])[2] is True
  assert split_indices([0, 0, 0, 0, 0, 0, 0, 1])[1] == []

  assert cosine_similarity([], [1.0, 0.0]) == 0.0
