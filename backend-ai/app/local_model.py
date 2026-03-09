from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol
import json
import math

from .config import Settings
from .defaults import QUADRANT_NAMES, get_quadrant_name, normalize_language


def utc_now() -> str:
  return datetime.now(tz=timezone.utc).isoformat()


class ModelNotReadyError(RuntimeError):
  pass


class EncoderProtocol(Protocol):
  def encode(
    self,
    texts: list[str],
    *,
    normalize_embeddings: bool = True,
    convert_to_numpy: bool = True,
    show_progress_bar: bool = False,
  ) -> Any:
    ...


@dataclass(frozen=True)
class SimilarExample:
  text: str
  quadrant: int
  source: str
  score: float

  def to_dict(self, language: str = "en") -> dict[str, Any]:
    return {
      "text": self.text,
      "quadrant": self.quadrant,
      "quadrant_name": get_quadrant_name(self.quadrant, language),
      "source": self.source,
      "score": round(self.score, 4),
    }


@dataclass(frozen=True)
class LocalPrediction:
  quadrant: int
  confidence: float
  probabilities: list[float]
  similar_examples: list[SimilarExample]


class LocalMiniLMClassifier:
  def __init__(
    self,
    settings: Settings,
    encoder: EncoderProtocol | None = None,
    sentence_transformer_factory: Any | None = None,
    torch_module: Any | None = None,
  ):
    self.settings = settings
    self._encoder = encoder
    self._sentence_transformer_factory = sentence_transformer_factory
    self._torch = torch_module
    self._head = None
    self._index: dict[str, Any] | None = None
    self._embedding_dim: int | None = None
    self._status = {
      "ready": False,
      "name": "local-minilm-mlp",
      "encoder_name": settings.local_model_name,
      "artifact_path": str(self.head_path),
      "index_path": str(self.index_path),
      "trained_at": None,
      "validation_skipped": True,
      "last_error": None,
      "examples_seen": 0,
    }

  @property
  def head_path(self) -> Path:
    return self.settings.model_cache_dir / "local_minilm_head.pt"

  @property
  def meta_path(self) -> Path:
    return self.settings.model_cache_dir / "local_minilm_meta.json"

  @property
  def index_path(self) -> Path:
    return self.settings.model_cache_dir / "local_minilm_index.json"

  def status(self) -> dict[str, Any]:
    payload = dict(self._status)
    payload["ready"] = bool(self._status["ready"])
    return payload

  def ensure_ready(self, records: list[dict[str, Any]]) -> None:
    if self._status["ready"]:
      return

    self.settings.model_cache_dir.mkdir(parents=True, exist_ok=True)
    try:
      if self.head_path.exists() and self.meta_path.exists() and self.index_path.exists():
        self._load_artifacts()
        return

      self.train(records)
    except ModelNotReadyError as issue:
      self._mark_not_ready(str(issue))
      raise
    except Exception as issue:
      self._mark_not_ready(str(issue))
      raise ModelNotReadyError(str(issue)) from issue

  def predict(self, task: str, limit: int = 3) -> LocalPrediction:
    self._require_ready()
    if not task.strip():
      raise ValueError("Task must not be empty.")

    embedding = self._encode([task])[0]
    probabilities = self._predict_probabilities(embedding)
    quadrant = max(range(len(probabilities)), key=probabilities.__getitem__)
    similar_examples = self._find_similar_examples_for_embedding(embedding, limit=limit)

    return LocalPrediction(
      quadrant=quadrant,
      confidence=round(probabilities[quadrant], 4),
      probabilities=[round(value, 4) for value in probabilities],
      similar_examples=similar_examples,
    )

  def predict_many(self, tasks: list[str], limit: int = 3) -> list[LocalPrediction]:
    self._require_ready()
    if any(not task.strip() for task in tasks):
      raise ValueError("Task must not be empty.")

    embeddings = self._encode(tasks)
    probability_rows = self._predict_probabilities_many(embeddings)

    predictions: list[LocalPrediction] = []
    for embedding, probabilities in zip(embeddings, probability_rows):
      quadrant = max(range(len(probabilities)), key=probabilities.__getitem__)
      predictions.append(
        LocalPrediction(
          quadrant=quadrant,
          confidence=round(probabilities[quadrant], 4),
          probabilities=[round(value, 4) for value in probabilities],
          similar_examples=self._find_similar_examples_for_embedding(embedding, limit=limit),
        )
      )

    return predictions

  def find_similar_examples(self, task: str, limit: int = 3) -> list[SimilarExample]:
    self._require_ready()
    query_embedding = self._encode([task])[0]
    return self._find_similar_examples_for_embedding(query_embedding, limit=limit)

  def _find_similar_examples_for_embedding(
    self,
    query_embedding: list[float],
    limit: int = 3,
  ) -> list[SimilarExample]:
    if limit <= 0:
      return []

    index = self._index or self._load_index()
    scored: list[SimilarExample] = []
    for item in index.get("items", []):
      similarity = cosine_similarity(query_embedding, item["embedding"])
      if similarity <= 0:
        continue
      scored.append(
        SimilarExample(
          text=item["text"],
          quadrant=item["quadrant"],
          source=item.get("source", "unknown"),
          score=similarity,
        )
      )

    scored.sort(key=lambda candidate: candidate.score, reverse=True)
    return scored[:limit]

  def explain(
    self,
    task: str,
    language: str = "en",
    prediction: LocalPrediction | None = None,
  ) -> dict[str, Any]:
    resolved_prediction = prediction or self.predict(task, limit=3)
    resolved_language = normalize_language(language)
    quadrant_name = get_quadrant_name(resolved_prediction.quadrant, resolved_language)

    if resolved_prediction.similar_examples:
      example_descriptions = ", ".join(
        (
          f'„{example.text}” ({get_quadrant_name(example.quadrant, resolved_language)}, '
          f'{round(example.score * 100)}%)'
        )
        for example in resolved_prediction.similar_examples[:2]
      )
    else:
      example_descriptions = ""

    confidence_pct = round(resolved_prediction.confidence * 100)
    if resolved_language == "pl":
      reasoning = (
        f'Lokalny model MiniLM przypisał zadanie do kwadrantu „{quadrant_name}” '
        f'z pewnością {confidence_pct}%.'
      )
      if example_descriptions:
        reasoning += f" Najbliższe przykłady treningowe: {example_descriptions}."
      else:
        reasoning += " Model nie znalazł silnie podobnych przykładów w lokalnym zbiorze."
    else:
      reasoning = (
        f'The local MiniLM model assigned this task to the "{quadrant_name}" quadrant '
        f'with {confidence_pct}% confidence.'
      )
      if example_descriptions:
        reasoning += f" Closest training examples: {example_descriptions}."
      else:
        reasoning += " The model did not find strongly similar examples in the local dataset."

    return {
      "quadrant": resolved_prediction.quadrant,
      "quadrant_name": quadrant_name,
      "confidence": resolved_prediction.confidence,
      "reasoning": reasoning,
      "method": "local-analysis",
      "similar_examples": [example.to_dict(resolved_language) for example in resolved_prediction.similar_examples],
    }

  def train(self, records: list[dict[str, Any]]) -> dict[str, Any]:
    cleaned_records = [record for record in records if record.get("text", "").strip()]
    if not cleaned_records:
      self._status.update({"ready": False, "last_error": "No training examples available.", "examples_seen": 0})
      raise ModelNotReadyError("No training examples available.")

    texts = [record["text"].strip() for record in cleaned_records]
    labels = [int(record["quadrant"]) for record in cleaned_records]
    sources = [record.get("source", "unknown") for record in cleaned_records]
    embeddings = self._encode(texts)
    embedding_dim = len(embeddings[0]) if embeddings else self._resolve_embedding_dim()
    self._embedding_dim = embedding_dim

    train_indices, validation_indices, validation_skipped = split_indices(labels)
    torch = self._require_torch()
    torch.manual_seed(7)

    embedding_tensor = torch.tensor(embeddings, dtype=torch.float32)
    label_tensor = torch.tensor(labels, dtype=torch.long)

    head = self._build_head(embedding_dim)
    optimizer = torch.optim.AdamW(head.parameters(), lr=self.settings.local_model_learning_rate)
    criterion = torch.nn.CrossEntropyLoss()

    best_state = {key: value.detach().clone() for key, value in head.state_dict().items()}
    best_loss = math.inf
    patience_left = self.settings.local_model_patience

    for _ in range(self.settings.local_model_epochs):
      head.train()
      optimizer.zero_grad()
      logits = head(embedding_tensor[train_indices])
      loss = criterion(logits, label_tensor[train_indices])
      loss.backward()
      optimizer.step()

      current_loss = float(loss.detach().item())
      if validation_indices:
        head.eval()
        with torch.no_grad():
          validation_logits = head(embedding_tensor[validation_indices])
          validation_loss = criterion(validation_logits, label_tensor[validation_indices])
          current_loss = float(validation_loss.detach().item())

      if current_loss < best_loss - 1e-4:
        best_loss = current_loss
        best_state = {key: value.detach().clone() for key, value in head.state_dict().items()}
        patience_left = self.settings.local_model_patience
      else:
        patience_left -= 1
        if patience_left <= 0:
          break

    head.load_state_dict(best_state)
    self._head = head.eval()

    trained_at = utc_now()
    meta = {
      "name": "local-minilm-mlp",
      "encoder_name": self.settings.local_model_name,
      "hidden_dim": self.settings.local_model_hidden_dim,
      "dropout": self.settings.local_model_dropout,
      "embedding_dim": embedding_dim,
      "trained_at": trained_at,
      "examples_seen": len(cleaned_records),
      "validation_skipped": validation_skipped,
      "class_distribution": dict(Counter(str(label) for label in labels)),
    }
    index = {
      "updated_at": trained_at,
      "items": [
        {
          "text": text,
          "quadrant": quadrant,
          "source": source,
          "embedding": embedding,
        }
        for text, quadrant, source, embedding in zip(texts, labels, sources, embeddings)
      ],
    }

    self.settings.model_cache_dir.mkdir(parents=True, exist_ok=True)
    torch.save(self._head.state_dict(), self.head_path)
    self.meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    self.index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")

    self._index = index
    self._status.update(
      {
        "ready": True,
        "trained_at": trained_at,
        "validation_skipped": validation_skipped,
        "last_error": None,
        "examples_seen": len(cleaned_records),
      }
    )

    return {
      "artifact_path": str(self.head_path),
      "trained_at": trained_at,
      "validation_skipped": validation_skipped,
      "examples_seen": len(cleaned_records),
    }

  def _load_artifacts(self) -> None:
    torch = self._require_torch()
    metadata = json.loads(self.meta_path.read_text(encoding="utf-8"))
    self._validate_artifact_metadata(metadata)
    embedding_dim = int(metadata.get("embedding_dim") or self._resolve_embedding_dim())
    self._embedding_dim = embedding_dim
    head = self._build_head(embedding_dim)
    try:
      state = torch.load(self.head_path, map_location="cpu", weights_only=True)
    except TypeError:
      state = torch.load(self.head_path, map_location="cpu")
    head.load_state_dict(state)
    head.eval()
    self._head = head
    self._index = self._load_index()
    self._status.update(
      {
        "ready": True,
        "trained_at": metadata.get("trained_at"),
        "validation_skipped": metadata.get("validation_skipped", True),
        "last_error": None,
        "examples_seen": metadata.get("examples_seen", 0),
      }
    )

  def _load_index(self) -> dict[str, Any]:
    index = json.loads(self.index_path.read_text(encoding="utf-8"))
    self._index = index
    return index

  def _predict_probabilities(self, embedding: list[float]) -> list[float]:
    return self._predict_probabilities_many([embedding])[0]

  def _predict_probabilities_many(self, embeddings: list[list[float]]) -> list[list[float]]:
    torch = self._require_torch()
    self._require_ready()
    with torch.no_grad():
      logits = self._head(torch.tensor(embeddings, dtype=torch.float32))
      probability_rows = torch.softmax(logits, dim=1).tolist()
    return [[float(value) for value in probabilities] for probabilities in probability_rows]

  def _build_head(self, input_dim: int | None = None):
    torch = self._require_torch()
    resolved_input_dim = input_dim or self._embedding_dim or self._resolve_embedding_dim()
    return torch.nn.Sequential(
      torch.nn.Linear(resolved_input_dim, self.settings.local_model_hidden_dim),
      torch.nn.GELU(),
      torch.nn.Dropout(self.settings.local_model_dropout),
      torch.nn.Linear(self.settings.local_model_hidden_dim, len(QUADRANT_NAMES)),
    )

  def _encode(self, texts: list[str]) -> list[list[float]]:
    encoder = self._load_encoder()
    raw_embeddings = encoder.encode(
      texts,
      normalize_embeddings=True,
      convert_to_numpy=True,
      show_progress_bar=False,
    )
    if hasattr(raw_embeddings, "tolist"):
      raw_embeddings = raw_embeddings.tolist()
    return [[float(value) for value in embedding] for embedding in raw_embeddings]

  def _load_encoder(self) -> EncoderProtocol:
    if self._encoder is not None:
      return self._encoder

    if self._sentence_transformer_factory is None:
      from sentence_transformers import SentenceTransformer

      self._sentence_transformer_factory = SentenceTransformer

    self._encoder = self._sentence_transformer_factory(self.settings.local_model_name)
    return self._encoder

  def _resolve_embedding_dim(self) -> int:
    if self._embedding_dim is not None:
      return self._embedding_dim

    encoder = self._load_encoder()
    dimension_getter = getattr(encoder, "get_sentence_embedding_dimension", None)
    if callable(dimension_getter):
      dimension = int(dimension_getter())
      if dimension > 0:
        self._embedding_dim = dimension
        return dimension

    probe = encoder.encode(
      ["dimension probe"],
      normalize_embeddings=True,
      convert_to_numpy=True,
      show_progress_bar=False,
    )
    if hasattr(probe, "tolist"):
      probe = probe.tolist()

    dimension = len(probe[0])
    self._embedding_dim = dimension
    return dimension

  def _validate_artifact_metadata(self, metadata: dict[str, Any]) -> None:
    artifact_encoder = metadata.get("encoder_name")
    if artifact_encoder and artifact_encoder != self.settings.local_model_name:
      raise ModelNotReadyError(
        "Saved model artifacts were created for a different encoder. "
        "Clear the cache or retrain the local model."
      )

    artifact_hidden_dim = int(metadata.get("hidden_dim", self.settings.local_model_hidden_dim))
    if artifact_hidden_dim != self.settings.local_model_hidden_dim:
      raise ModelNotReadyError(
        "Saved model artifacts were created with a different hidden dimension. "
        "Clear the cache or retrain the local model."
      )

  def _mark_not_ready(self, error: str) -> None:
    self._head = None
    self._index = None
    self._status.update(
      {
        "ready": False,
        "trained_at": None,
        "validation_skipped": True,
        "last_error": error,
      }
    )

  def _require_torch(self):
    if self._torch is None:
      import torch

      self._torch = torch
    return self._torch

  def _require_ready(self) -> None:
    if not self._status["ready"] or self._head is None:
      message = self._status["last_error"] or "Local model is not ready."
      raise ModelNotReadyError(message)


def split_indices(labels: list[int]) -> tuple[list[int], list[int], bool]:
  if len(labels) < 8:
    return list(range(len(labels))), [], True

  counts = Counter(labels)
  if any(count < 2 for count in counts.values()):
    return list(range(len(labels))), [], True

  per_label_seen: dict[int, int] = {label: 0 for label in counts}
  validation_indices: list[int] = []
  train_indices: list[int] = []
  target_validation_counts = {label: max(1, count // 4) for label, count in counts.items()}

  for index, label in enumerate(labels):
    if per_label_seen[label] < target_validation_counts[label]:
      validation_indices.append(index)
      per_label_seen[label] += 1
    else:
      train_indices.append(index)

  return train_indices, validation_indices, False


def cosine_similarity(left: list[float], right: list[float]) -> float:
  if not left or not right:
    return 0.0

  numerator = sum(left_value * right_value for left_value, right_value in zip(left, right))
  left_norm = math.sqrt(sum(value * value for value in left))
  right_norm = math.sqrt(sum(value * value for value in right))
  if left_norm == 0 or right_norm == 0:
    return 0.0
  return numerator / (left_norm * right_norm)
