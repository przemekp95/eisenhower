from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol
import hashlib
import fcntl
import json
import math
import os
import random
import shutil
import threading
import uuid

from .config import Settings
from .defaults import QUADRANT_NAMES, get_quadrant_name, normalize_language
from .evaluation import (
  assess_promotion,
  centroid_logits,
  classification_metrics,
  evaluation_governance_issues,
  fit_temperature,
  load_evaluation_dataset,
  normalize_text,
  selective_classification_metrics,
  semantic_leakage_report,
  softmax_rows,
)


ARTIFACT_SCHEMA_VERSION = 2
LABEL_CONTRACT = {"0": "Do Now", "1": "Delegate", "2": "Schedule", "3": "Delete"}


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
  requires_confirmation: bool = False
  confidence_calibrated: bool = False


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
    self._temperature = 1.0
    self._calibration_fitted = False
    self._generation_id: str | None = None
    self._training_lock = threading.RLock()
    self._status = {
      "ready": False,
      "name": "local-minilm-mlp",
      "encoder_name": settings.local_model_name,
      "encoder_revision": settings.local_model_revision,
      "artifact_path": str(self.head_path),
      "index_path": str(self.index_path),
      "trained_at": None,
      "validation_skipped": True,
      "last_error": None,
      "examples_seen": 0,
      "temperature": 1.0,
      "confidence_calibrated": False,
      "quality_gate": None,
      "generation_id": None,
      "data_stale": False,
    }

  @property
  def current_pointer_path(self) -> Path:
    return self.settings.local_model_artifact_dir / "local_minilm_current.json"

  @property
  def generations_dir(self) -> Path:
    return self.settings.local_model_artifact_dir / "local_minilm_generations"

  def _active_artifact_path(self, filename: str) -> Path:
    pointer = self._read_current_pointer()
    generation_id = pointer.get("generation_id") if pointer else None
    if generation_id:
      return self.generations_dir / str(generation_id) / filename
    return self.settings.local_model_artifact_dir / filename

  @property
  def head_path(self) -> Path:
    return self._active_artifact_path("local_minilm_head.pt")

  @property
  def meta_path(self) -> Path:
    return self._active_artifact_path("local_minilm_meta.json")

  @property
  def index_path(self) -> Path:
    return self._active_artifact_path("local_minilm_index.json")

  def status(self) -> dict[str, Any]:
    if self._status["ready"]:
      self._refresh_if_generation_changed()
    payload = dict(self._status)
    approval_active = self._owner_approval_active()
    payload["ready"] = bool(self._status["ready"] and approval_active)
    if not approval_active:
      payload["last_error"] = "Owner approval expired; classifier is fail-closed."
    return payload

  def ensure_ready(self, records: list[dict[str, Any]]) -> None:
    if self._status["ready"]:
      return

    self.settings.local_model_artifact_dir.mkdir(parents=True, exist_ok=True)
    try:
      if self.head_path.exists() and self.meta_path.exists() and self.index_path.exists():
        self._load_artifacts(expected_records=None)
        current_fingerprint = records_fingerprint(clean_training_records(records))
        artifact_fingerprint = (self._index or {}).get("dataset_fingerprint")
        self._status["data_stale"] = artifact_fingerprint != current_fingerprint
        return

      if self.settings.app_env == "production":
        raise ModelNotReadyError(
          "An approved classifier artifact is required; production startup training is forbidden."
        )
      self.train(records)
    except ModelNotReadyError as issue:
      self._mark_not_ready(str(issue))
      raise
    except Exception as issue:
      self._mark_not_ready(str(issue))
      raise ModelNotReadyError(str(issue)) from issue

  def predict(self, task: str, limit: int = 3) -> LocalPrediction:
    self._refresh_if_generation_changed()
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
      requires_confirmation=probabilities[quadrant] < self.settings.local_model_confidence_threshold,
      confidence_calibrated=self._calibration_fitted,
    )

  def predict_many(self, tasks: list[str], limit: int = 3) -> list[LocalPrediction]:
    self._refresh_if_generation_changed()
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
          requires_confirmation=probabilities[quadrant] < self.settings.local_model_confidence_threshold,
          confidence_calibrated=self._calibration_fitted,
        )
      )

    return predictions

  def find_similar_examples(self, task: str, limit: int = 3) -> list[SimilarExample]:
    self._refresh_if_generation_changed()
    self._require_ready()
    query_embedding = self._encode([task])[0]
    return self._find_similar_examples_for_embedding(query_embedding, limit=limit)

  def encode_text(self, text: str) -> list[float]:
    if not text.strip():
      raise ValueError("Task must not be empty.")

    return self._encode([text])[0]

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
    with self._training_lock:
      with self._process_training_lock():
        return self._train_locked(records)

  def _train_locked(self, records: list[dict[str, Any]]) -> dict[str, Any]:
    cleaned_records = clean_training_records(records)
    if not cleaned_records:
      self._status.update({"ready": False, "last_error": "No training examples available.", "examples_seen": 0})
      raise ModelNotReadyError("No training examples available.")

    texts = [record["text"].strip() for record in cleaned_records]
    labels = [int(record["quadrant"]) for record in cleaned_records]
    missing_classes = sorted(set(QUADRANT_NAMES).difference(labels))
    if missing_classes:
      message = f"Training data must contain all four classes; missing: {missing_classes}."
      self._status.update({"ready": bool(self._head), "last_error": message, "examples_seen": len(cleaned_records)})
      raise ModelNotReadyError(message)
    sources = [record.get("source", "unknown") for record in cleaned_records]
    embeddings = self._encode(texts)
    embedding_dim = len(embeddings[0]) if embeddings else self._resolve_embedding_dim()
    self._embedding_dim = embedding_dim

    train_indices, stopping_indices, calibration_indices, validation_skipped = three_way_split_indices(labels)
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
      if stopping_indices:
        head.eval()
        with torch.no_grad():
          validation_logits = head(embedding_tensor[stopping_indices])
          validation_loss = criterion(validation_logits, label_tensor[stopping_indices])
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
    candidate_head = head.eval()

    temperature = 1.0
    if calibration_indices:
      validation_logits = self._logits_for_head(candidate_head, [embeddings[index] for index in calibration_indices])
      temperature = fit_temperature(validation_logits, [labels[index] for index in calibration_indices])
    calibration_fitted = bool(calibration_indices)

    trained_at = utc_now()
    meta = {
      "name": "local-minilm-mlp",
      "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
      "label_contract": LABEL_CONTRACT,
      "encoder_name": self.settings.local_model_name,
      "encoder_revision": self.settings.local_model_revision,
      "hidden_dim": self.settings.local_model_hidden_dim,
      "dropout": self.settings.local_model_dropout,
      "embedding_dim": embedding_dim,
      "trained_at": trained_at,
      "examples_seen": len(cleaned_records),
      "validation_skipped": validation_skipped,
      "class_distribution": dict(Counter(str(label) for label in labels)),
      "dataset_fingerprint": records_fingerprint(cleaned_records),
      "temperature": temperature,
      "confidence_calibrated": calibration_fitted,
    }
    index = {
      "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
      "dataset_fingerprint": meta["dataset_fingerprint"],
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

    quality_report = self._evaluate_candidate(
      candidate_head,
      temperature,
      embeddings,
      labels,
      texts,
      train_indices,
      calibration_indices,
    )
    meta["quality_gate"] = quality_report
    if quality_report is not None and not quality_report["gate"]["passed"]:
      self._status["quality_gate"] = quality_report
      if self._head is None:
        message = "Candidate model rejected by the quality gate."
        self._mark_not_ready(message)
        raise ModelNotReadyError(message)
      return {
        "artifact_path": str(self.head_path),
        "trained_at": self._status.get("trained_at"),
        "validation_skipped": validation_skipped,
        "examples_seen": len(cleaned_records),
        "promoted": False,
        "quality_gate": quality_report,
      }

    generation_id = self._persist_candidate(candidate_head, meta, index)
    self._head = candidate_head
    self._temperature = temperature
    self._calibration_fitted = calibration_fitted
    self._generation_id = generation_id

    self._index = index
    self._status.update(
      {
        "ready": True,
        "trained_at": trained_at,
        "validation_skipped": validation_skipped,
        "last_error": None,
        "examples_seen": len(cleaned_records),
        "temperature": temperature,
        "confidence_calibrated": calibration_fitted,
        "quality_gate": quality_report,
        "generation_id": generation_id,
        "data_stale": False,
        "artifact_path": str(self.head_path),
        "index_path": str(self.index_path),
      }
    )

    return {
      "artifact_path": str(self.head_path),
      "trained_at": trained_at,
      "validation_skipped": validation_skipped,
      "examples_seen": len(cleaned_records),
      "promoted": True,
      "quality_gate": quality_report,
    }

  def _load_artifacts(self, expected_records: list[dict[str, Any]] | None = None) -> None:
    torch = self._require_torch()
    metadata = json.loads(self.meta_path.read_text(encoding="utf-8"))
    self._validate_active_generation_checksums()
    self._validate_artifact_metadata(metadata, expected_records=expected_records)
    expected_head_hash = metadata.get("head_sha256")
    if expected_head_hash and hashlib.sha256(self.head_path.read_bytes()).hexdigest() != expected_head_hash:
      raise ModelNotReadyError("Saved model head checksum does not match its metadata.")
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
    self._temperature = float(metadata.get("temperature", 1.0))
    self._calibration_fitted = bool(metadata.get("confidence_calibrated", False))
    self._generation_id = metadata.get("generation_id")
    self._index = self._load_index()
    self._status.update(
      {
        "ready": True,
        "trained_at": metadata.get("trained_at"),
        "validation_skipped": metadata.get("validation_skipped", True),
        "last_error": None,
        "examples_seen": metadata.get("examples_seen", 0),
        "temperature": self._temperature,
        "confidence_calibrated": self._calibration_fitted,
        "quality_gate": metadata.get("quality_gate"),
        "generation_id": self._generation_id,
        "data_stale": False,
        "artifact_path": str(self.head_path),
        "index_path": str(self.index_path),
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
      probability_rows = torch.softmax(logits / self._temperature, dim=1).tolist()
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

    self._encoder = self._sentence_transformer_factory(
      self.settings.local_model_name,
      revision=self.settings.local_model_revision,
    )
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

  def _validate_artifact_metadata(
    self,
    metadata: dict[str, Any],
    *,
    expected_records: list[dict[str, Any]] | None = None,
  ) -> None:
    artifact_encoder = metadata.get("encoder_name")
    if artifact_encoder and artifact_encoder != self.settings.local_model_name:
      raise ModelNotReadyError(
        "Saved model artifacts were created for a different encoder. "
        "Clear the cache or retrain the local model."
      )
    artifact_revision = metadata.get("encoder_revision")
    if artifact_revision != self.settings.local_model_revision:
      raise ModelNotReadyError(
        "Saved model artifacts were created for a different encoder revision. "
        "Clear the cache or retrain the local model."
      )

    artifact_hidden_dim = int(metadata.get("hidden_dim", self.settings.local_model_hidden_dim))
    if artifact_hidden_dim != self.settings.local_model_hidden_dim:
      raise ModelNotReadyError(
        "Saved model artifacts were created with a different hidden dimension. "
        "Clear the cache or retrain the local model."
      )

    if int(metadata.get("artifact_schema_version", 0)) != ARTIFACT_SCHEMA_VERSION:
      raise ModelNotReadyError("Saved model artifacts use an incompatible schema. Retrain the local model.")
    if metadata.get("label_contract") != LABEL_CONTRACT:
      raise ModelNotReadyError("Saved model artifacts use a different four-class label contract.")
    if expected_records is not None:
      expected_fingerprint = records_fingerprint(clean_training_records(expected_records))
      if metadata.get("dataset_fingerprint") != expected_fingerprint:
        raise ModelNotReadyError("Saved model artifacts were trained on different data. Retrain the local model.")

  def _logits_for_head(self, head: Any, embeddings: list[list[float]]) -> list[list[float]]:
    if not embeddings:
      return []
    torch = self._require_torch()
    with torch.no_grad():
      return [[float(value) for value in row] for row in head(torch.tensor(embeddings, dtype=torch.float32)).tolist()]

  def _evaluate_candidate(
    self,
    candidate_head: Any,
    temperature: float,
    embeddings: list[list[float]],
    labels: list[int],
    texts: list[str],
    train_indices: list[int],
    validation_indices: list[int],
  ) -> dict[str, Any] | None:
    if self.settings.local_model_owner_approval_bypass:
      self._require_active_owner_approval()
      return {
        "evaluation_dataset": None,
        "evaluation_sha256": None,
        "evaluation_profile": self.settings.local_model_evaluation_profile,
        "governance_issues": [{"code": "owner_accepted_missing_independent_evaluation"}],
        "gate": {
          "passed": True,
          "mode": "time_bounded_owner_approval",
          "valid_until": self.settings.local_model_owner_approval_valid_until,
          "reasons": [],
        },
      }
    evaluation_path = self.settings.evaluation_data_path
    if evaluation_path is None or not evaluation_path.exists():
      if self.settings.local_model_require_evaluation:
        raise ModelNotReadyError("Required evaluation dataset is missing; candidate promotion is fail-closed.")
      return None

    dataset = load_evaluation_dataset(evaluation_path, training_texts=texts)
    evaluation_sha256 = hashlib.sha256(evaluation_path.read_bytes()).hexdigest()
    examples = dataset["examples"]
    evaluation_embeddings = self._encode([item["text"] for item in examples])
    evaluation_labels = [int(item["quadrant"]) for item in examples]

    candidate_logits = self._logits_for_head(candidate_head, evaluation_embeddings)
    candidate_probabilities = softmax_rows(candidate_logits, temperature=temperature)
    candidate_predictions = [max(range(4), key=row.__getitem__) for row in candidate_probabilities]
    candidate_metrics = classification_metrics(evaluation_labels, candidate_predictions, candidate_probabilities)
    by_language: dict[str, Any] = {}
    for language in sorted({str(item["language"]) for item in examples}):
      language_indices = [index for index, item in enumerate(examples) if item["language"] == language]
      by_language[language] = classification_metrics(
        [evaluation_labels[index] for index in language_indices],
        [candidate_predictions[index] for index in language_indices],
        [candidate_probabilities[index] for index in language_indices],
      )
    candidate_metrics["by_language"] = by_language
    selective_metrics = selective_classification_metrics(
      evaluation_labels,
      candidate_predictions,
      candidate_probabilities,
      threshold=self.settings.local_model_confidence_threshold,
    )
    leakage = semantic_leakage_report(
      embeddings,
      evaluation_embeddings,
      threshold=self.settings.local_model_semantic_leakage_threshold,
    )
    governance_issues = evaluation_governance_issues(
      dataset,
      profile=self.settings.local_model_evaluation_profile,
    )

    baseline_temperature = 1.0
    if validation_indices:
      baseline_validation_logits = centroid_logits(
        [embeddings[index] for index in train_indices],
        [labels[index] for index in train_indices],
        [embeddings[index] for index in validation_indices],
      )
      baseline_temperature = fit_temperature(
        baseline_validation_logits,
        [labels[index] for index in validation_indices],
      )
    baseline_logits = centroid_logits(embeddings, labels, evaluation_embeddings)
    baseline_probabilities = softmax_rows(baseline_logits, temperature=baseline_temperature)
    baseline_predictions = [max(range(4), key=row.__getitem__) for row in baseline_probabilities]
    baseline_metrics = classification_metrics(evaluation_labels, baseline_predictions, baseline_probabilities)

    incumbent_metrics = None
    if self._head is not None:
      incumbent_logits = self._logits_for_head(self._head, evaluation_embeddings)
      incumbent_probabilities = softmax_rows(incumbent_logits, temperature=self._temperature)
      incumbent_predictions = [max(range(4), key=row.__getitem__) for row in incumbent_probabilities]
      incumbent_metrics = classification_metrics(evaluation_labels, incumbent_predictions, incumbent_probabilities)

    gate = assess_promotion(
      candidate_metrics,
      baseline_metrics=baseline_metrics,
      incumbent_metrics=incumbent_metrics,
      minimum_macro_f1=self.settings.local_model_minimum_macro_f1,
      maximum_ece=self.settings.local_model_maximum_ece,
      maximum_nll=self.settings.local_model_maximum_nll,
      maximum_brier=self.settings.local_model_maximum_brier,
      minimum_per_class_f1=self.settings.local_model_minimum_per_class_f1,
      allowed_regression=self.settings.local_model_allowed_regression,
    )
    gate_reasons = gate["reasons"]
    gate_reasons.extend(governance_issues)
    approved_sha256 = self.settings.local_model_approved_evaluation_sha256
    if self.settings.local_model_evaluation_profile == "production":
      if approved_sha256 is None:
        gate_reasons.append({"code": "approved_evaluation_sha256_missing"})
      elif evaluation_sha256 != approved_sha256:
        gate_reasons.append(
          {"code": "approved_evaluation_sha256_mismatch", "actual": evaluation_sha256, "required": approved_sha256}
        )
    if leakage["pairs_above_threshold"] > self.settings.local_model_maximum_semantic_leaks:
      gate_reasons.append(
        {
          "code": "semantic_evaluation_leakage",
          "actual": leakage["pairs_above_threshold"],
          "maximum": self.settings.local_model_maximum_semantic_leaks,
        }
      )
    weak_languages = {
      language: metrics["macro_f1"]
      for language, metrics in by_language.items()
      if float(metrics["macro_f1"]) < self.settings.local_model_minimum_language_macro_f1
    }
    if weak_languages:
      gate_reasons.append(
        {
          "code": "language_macro_f1_too_low",
          "actual": weak_languages,
          "minimum": self.settings.local_model_minimum_language_macro_f1,
        }
      )
    if selective_metrics["coverage"] < self.settings.local_model_minimum_automatic_coverage:
      gate_reasons.append(
        {
          "code": "automatic_coverage_too_low",
          "actual": selective_metrics["coverage"],
          "minimum": self.settings.local_model_minimum_automatic_coverage,
        }
      )
    accepted_accuracy = selective_metrics["accepted_accuracy"]
    if accepted_accuracy is None or accepted_accuracy < self.settings.local_model_minimum_selective_accuracy:
      gate_reasons.append(
        {
          "code": "selective_accuracy_too_low",
          "actual": accepted_accuracy,
          "minimum": self.settings.local_model_minimum_selective_accuracy,
        }
      )
    gate["passed"] = not gate_reasons
    return {
      "evaluation_dataset": dataset["name"],
      "evaluation_sha256": evaluation_sha256,
      "evaluation_profile": self.settings.local_model_evaluation_profile,
      "governance_issues": governance_issues,
      "semantic_leakage": leakage,
      "selective": selective_metrics,
      "candidate": candidate_metrics,
      "centroid_baseline": baseline_metrics,
      "incumbent": incumbent_metrics,
      "gate": gate,
    }

  def _persist_candidate(self, head: Any, meta: dict[str, Any], index: dict[str, Any]) -> str:
    torch = self._require_torch()
    self.settings.local_model_artifact_dir.mkdir(parents=True, exist_ok=True)
    candidate_id = uuid.uuid4().hex
    self.generations_dir.mkdir(parents=True, exist_ok=True)
    candidate_dir = self.generations_dir / f".candidate-{candidate_id}"
    generation_dir = self.generations_dir / candidate_id
    candidate_dir.mkdir(parents=False, exist_ok=False)
    candidate_head = candidate_dir / "local_minilm_head.pt"
    candidate_meta = candidate_dir / "local_minilm_meta.json"
    candidate_index = candidate_dir / "local_minilm_index.json"
    pointer_candidate = self.settings.local_model_artifact_dir / f".{candidate_id}.current.json"
    try:
      torch.save(head.state_dict(), candidate_head)
      with candidate_head.open("rb") as artifact_handle:
        os.fsync(artifact_handle.fileno())
      meta["generation_id"] = candidate_id
      meta["head_sha256"] = hashlib.sha256(candidate_head.read_bytes()).hexdigest()
      self._durable_write_json(candidate_index, index)
      meta["index_sha256"] = hashlib.sha256(candidate_index.read_bytes()).hexdigest()
      self._durable_write_json(candidate_meta, meta)
      check_state = torch.load(candidate_head, map_location="cpu", weights_only=True)
      check_head = self._build_head(int(meta["embedding_dim"]))
      check_head.load_state_dict(check_state)
      pointer = {
        "generation_id": candidate_id,
        "head_sha256": meta["head_sha256"],
        "index_sha256": meta["index_sha256"],
        "meta_sha256": hashlib.sha256(candidate_meta.read_bytes()).hexdigest(),
      }
      self._durable_write_json(pointer_candidate, pointer)
      os.replace(candidate_dir, generation_dir)
      self._fsync_directory(self.generations_dir)
      os.replace(pointer_candidate, self.current_pointer_path)
      self._fsync_directory(self.settings.local_model_artifact_dir)
      return candidate_id
    finally:
      pointer_candidate.unlink(missing_ok=True)
      if candidate_dir.exists():
        shutil.rmtree(candidate_dir)

  @staticmethod
  def _durable_write_json(path: Path, payload: dict[str, Any]) -> None:
    with path.open("w", encoding="utf-8") as output:
      json.dump(payload, output, ensure_ascii=False, indent=2)
      output.flush()
      os.fsync(output.fileno())

  @staticmethod
  def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
      os.fsync(descriptor)
    finally:
      os.close(descriptor)

  def _read_current_pointer(self) -> dict[str, Any] | None:
    if not self.current_pointer_path.exists():
      return None
    try:
      payload = json.loads(self.current_pointer_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as issue:
      raise ModelNotReadyError(f"Current model generation pointer is invalid: {issue}") from issue
    generation_id = str(payload.get("generation_id", "")).strip()
    if not generation_id or Path(generation_id).name != generation_id:
      raise ModelNotReadyError("Current model generation pointer has an invalid generation id.")
    return payload

  def _validate_active_generation_checksums(self) -> None:
    pointer = self._read_current_pointer()
    if self.settings.app_env == "production":
      approved_digest = self.settings.local_model_approved_artifact_sha256
      if pointer is None or approved_digest is None:
        raise ModelNotReadyError(
          "An approved classifier artifact pointer and SHA-256 are required in production."
        )
      actual_digest = hashlib.sha256(self.current_pointer_path.read_bytes()).hexdigest()
      if actual_digest != approved_digest:
        raise ModelNotReadyError(
          "Approved classifier artifact checksum does not match the active generation pointer."
        )
    if pointer is None:
      return
    expected = {
      self.head_path: pointer.get("head_sha256"),
      self.index_path: pointer.get("index_sha256"),
      self.meta_path: pointer.get("meta_sha256"),
    }
    for path, checksum in expected.items():
      if not checksum or not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
        raise ModelNotReadyError(f"Active model generation checksum mismatch: {path.name}.")

  def _refresh_if_generation_changed(self) -> None:
    pointer = self._read_current_pointer()
    pointer_generation = str(pointer.get("generation_id")) if pointer else None
    if pointer_generation is None or pointer_generation == self._generation_id:
      return
    with self._training_lock:
      pointer = self._read_current_pointer()
      pointer_generation = str(pointer.get("generation_id")) if pointer else None
      if pointer_generation and pointer_generation != self._generation_id:
        self._load_artifacts(expected_records=None)

  @contextmanager
  def _process_training_lock(self):
    lock_path = self.settings.local_model_artifact_dir / "local_minilm_training.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as lock_handle:
      fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
      try:
        yield
      finally:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)

  def _mark_not_ready(self, error: str) -> None:
    self._head = None
    self._index = None
    self._calibration_fitted = False
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
    self._require_active_owner_approval()
    if not self._status["ready"] or self._head is None:
      message = self._status["last_error"] or "Local model is not ready."
      raise ModelNotReadyError(message)

  def _owner_approval_active(self) -> bool:
    if not self.settings.local_model_owner_approval_bypass:
      return True
    valid_until = self.settings.local_model_owner_approval_valid_until
    if not valid_until:
      return False
    return datetime.now(timezone.utc) <= datetime.fromisoformat(valid_until).astimezone(timezone.utc)

  def _require_active_owner_approval(self) -> None:
    if not self._owner_approval_active():
      raise ModelNotReadyError("Owner approval expired; classifier is fail-closed.")


def split_indices(labels: list[int], seed: int = 7) -> tuple[list[int], list[int], bool]:
  if len(labels) < 8:
    return list(range(len(labels))), [], True

  counts = Counter(labels)
  if any(count < 2 for count in counts.values()):
    return list(range(len(labels))), [], True

  validation_indices: list[int] = []
  target_validation_counts = {label: max(1, count // 4) for label, count in counts.items()}

  for label in sorted(counts):
    label_indices = [index for index, candidate in enumerate(labels) if candidate == label]
    random.Random(seed + label * 1009).shuffle(label_indices)
    validation_indices.extend(label_indices[:target_validation_counts[label]])

  validation_indices.sort()
  validation_set = set(validation_indices)
  train_indices = [index for index in range(len(labels)) if index not in validation_set]

  return train_indices, validation_indices, False


def three_way_split_indices(
  labels: list[int], seed: int = 7
) -> tuple[list[int], list[int], list[int], bool]:
  """Create disjoint fit, early-stopping and temperature-calibration slices."""
  counts = Counter(labels)
  if len(labels) < 12 or any(count < 3 for count in counts.values()):
    return list(range(len(labels))), [], [], True
  stopping: list[int] = []
  calibration: list[int] = []
  for label in sorted(counts):
    candidates = [index for index, value in enumerate(labels) if value == label]
    random.Random(seed + label * 1009).shuffle(candidates)
    stopping.append(candidates[0])
    calibration.append(candidates[1])
  held_out = set(stopping + calibration)
  fit = [index for index in range(len(labels)) if index not in held_out]
  return fit, sorted(stopping), sorted(calibration), False


def clean_training_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
  grouped: dict[str, list[dict[str, Any]]] = {}
  for record in records:
    text = str(record.get("text", "")).strip()
    if not text or record.get("training_status") == "pending_review":
      continue
    try:
      quadrant = int(record.get("quadrant"))
    except (TypeError, ValueError):
      continue
    if quadrant not in QUADRANT_NAMES:
      continue
    grouped.setdefault(normalize_text(text), []).append({**record, "text": text, "quadrant": quadrant})

  cleaned: list[dict[str, Any]] = []
  for candidates in grouped.values():
    if len({candidate["quadrant"] for candidate in candidates}) != 1:
      continue
    cleaned.append(candidates[0])
  return cleaned


def records_fingerprint(records: list[dict[str, Any]]) -> str:
  canonical = sorted((normalize_text(str(record["text"])), int(record["quadrant"])) for record in records)
  encoded = json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
  return hashlib.sha256(encoded).hexdigest()


def cosine_similarity(left: list[float], right: list[float]) -> float:
  if not left or not right:
    return 0.0

  numerator = sum(left_value * right_value for left_value, right_value in zip(left, right))
  left_norm = math.sqrt(sum(value * value for value in left))
  right_norm = math.sqrt(sum(value * value for value in right))
  if left_norm == 0 or right_norm == 0:
    return 0.0
  return numerator / (left_norm * right_norm)
