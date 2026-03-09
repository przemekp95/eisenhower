from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO
from typing import Any
import mimetypes
import re
import shutil

from PIL import Image
import pytesseract

from .config import Settings
from .defaults import QUADRANT_NAMES, get_quadrant_name, normalize_language
from .local_model import (
  LocalMiniLMClassifier,
  LocalPrediction,
  ModelNotReadyError,
  SimilarExample,
  cosine_similarity,
  utc_now,
)
from .store import TrainingStore


def quadrant_to_flags(quadrant: int) -> tuple[bool, bool]:
  return quadrant in {0, 1}, quadrant in {0, 2}


def normalize_extracted_tasks(tasks: list[str]) -> list[str]:
  seen: set[str] = set()
  normalized: list[str] = []

  for task in tasks:
    cleaned = re.sub(r"\s+", " ", task).strip(" -\t\r\n")
    if not cleaned:
      continue
    lowered = cleaned.lower()
    if lowered in seen:
      continue
    seen.add(lowered)
    normalized.append(cleaned)

  return normalized[:10]


def lexical_similarity(query: str, candidate: str) -> float:
  query_tokens = {token for token in re.split(r"[^a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]+", query.lower()) if token}
  candidate_tokens = {token for token in re.split(r"[^a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]+", candidate.lower()) if token}
  if not query_tokens or not candidate_tokens:
    return 0.0

  overlap = len(query_tokens & candidate_tokens)
  universe = len(query_tokens | candidate_tokens)
  return overlap / universe if universe else 0.0


class QuadrantAIService:
  def __init__(
    self,
    settings: Settings,
    store: TrainingStore,
    local_model: LocalMiniLMClassifier | None = None,
    ocr_runner: Any | None = None,
  ):
    self.settings = settings
    self.store = store
    self.local_model = local_model or LocalMiniLMClassifier(settings=settings)
    self.ocr_runner = ocr_runner or pytesseract.image_to_string
    self._startup_error: str | None = None

    try:
      self.local_model.ensure_ready(self.store.load())
    except Exception as issue:
      self._startup_error = str(issue)

  def capabilities(self) -> dict[str, Any]:
    model_status = dict(self.local_model.status())
    tesseract_enabled = self._tesseract_available()
    model_ready = bool(model_status["ready"]) and self._startup_error is None
    model_status["ready"] = model_ready
    model_status["last_error"] = self._startup_error or model_status.get("last_error")

    return {
      "classification": True,
      "langchain_analysis": True,
      "ocr": tesseract_enabled,
      "batch_analysis": True,
      "training_management": True,
      "providers": {
        "local_model": model_ready,
        "tesseract": tesseract_enabled,
        "ocr": tesseract_enabled,
      },
      "model": model_status,
    }

  def classify_task(self, task: str, use_rag: bool = True) -> dict[str, Any]:
    prediction = self._predict(task, limit=3 if use_rag else 0)
    urgent, important = quadrant_to_flags(prediction.quadrant)

    return {
      "task": task,
      "urgent": urgent,
      "important": important,
      "quadrant": prediction.quadrant,
      "quadrant_name": QUADRANT_NAMES[prediction.quadrant],
      "timestamp": utc_now(),
      "method": "local-minilm",
      "confidence": prediction.confidence,
      "local_scores": {
        str(index): round(score, 4) for index, score in enumerate(prediction.probabilities)
      },
      "similar_examples_used": len(prediction.similar_examples),
      "top_similar_examples": [example.to_dict("en") for example in prediction.similar_examples],
    }

  def analyze_with_reasoning(self, task: str, language: str = "en") -> dict[str, Any]:
    resolved_language = normalize_language(language)
    rag = self.classify_task(task, use_rag=True)
    explanation = self.local_model.explain(task, language=resolved_language)

    return {
      "task": task,
      "langchain_analysis": {
        "quadrant": explanation["quadrant"],
        "reasoning": explanation["reasoning"],
        "confidence": explanation["confidence"],
        "method": explanation["method"],
      },
      "rag_classification": {
        "quadrant": rag["quadrant"],
        "quadrant_name": get_quadrant_name(rag["quadrant"], resolved_language),
        "confidence": rag["confidence"],
      },
      "comparison": {
        "methods_agree": True,
        "confidence_difference": 0.0,
      },
      "timestamp": utc_now(),
    }

  def batch_analyze(self, tasks: list[str]) -> dict[str, Any]:
    batch_results = []
    method_summary = {
      "rag": {"quadrant_distribution": {str(index): 0 for index in QUADRANT_NAMES}},
      "langchain": {"quadrant_distribution": {str(index): 0 for index in QUADRANT_NAMES}},
    }

    for task in tasks:
      rag = self.classify_task(task)
      analysis = self.analyze_with_reasoning(task)["langchain_analysis"]
      rag_quadrant = rag["quadrant"]
      analysis_quadrant = analysis["quadrant"] if analysis["quadrant"] is not None else rag_quadrant

      method_summary["rag"]["quadrant_distribution"][str(rag_quadrant)] += 1
      method_summary["langchain"]["quadrant_distribution"][str(analysis_quadrant)] += 1
      batch_results.append(
        {
          "task": task,
          "analyses": {
            "rag": rag,
            "langchain": analysis,
          },
        }
      )

    return {
      "batch_results": batch_results,
      "summary": {
        "methods": method_summary,
        "total_tasks": len(tasks),
      },
      "timestamp": utc_now(),
    }

  def extract_tasks_from_image(
    self,
    filename: str,
    payload: bytes,
    content_type: str | None = None,
  ) -> dict[str, Any]:
    extracted_text = ""
    tasks: list[str] = []
    method = "filename-fallback"

    if content_type == "text/plain" or filename.lower().endswith(".txt"):
      extracted_text = payload.decode("utf-8", errors="ignore")
      tasks = normalize_extracted_tasks(extracted_text.splitlines())
      method = "plain-text"
    elif self._looks_like_image(filename, content_type) and self._tesseract_available():
      try:
        tasks, extracted_text = self._extract_tasks_with_tesseract(payload)
        method = "tesseract"
      except Exception:
        tasks = []

    if not tasks:
      fallback_name = filename.rsplit(".", 1)[0].replace("-", " ").strip() if filename else ""
      tasks = normalize_extracted_tasks([fallback_name]) if fallback_name else []
      if not extracted_text:
        extracted_text = fallback_name

    classified = []
    for task in tasks[:10]:
      classification = self.classify_task(task)
      classified.append(
        {
          "text": task,
          "quadrant": classification["quadrant"],
          "quadrant_name": classification["quadrant_name"],
          "confidence": classification["confidence"],
        }
      )

    counts = {index: 0 for index in QUADRANT_NAMES}
    for item in classified:
      counts[item["quadrant"]] += 1

    total = len(classified) or 1
    return {
      "filename": filename,
      "image_info": {
        "size_bytes": len(payload),
        "shape": "unknown",
      },
      "ocr": {
        "extracted_text": extracted_text,
        "raw_tasks_detected": len(tasks),
        "method": method,
      },
      "classified_tasks": classified,
      "summary": {
        "total_tasks": len(classified),
        "quadrant_distribution": {
          "counts": counts,
          "percentages": {key: round((value / total) * 100, 2) for key, value in counts.items()},
          "quadrant_names": QUADRANT_NAMES,
        },
      },
      "timestamp": utc_now(),
    }

  def retrain(self, preserve_experience: bool = True) -> dict[str, Any]:
    training_result = self.local_model.train(self.store.load())
    self._startup_error = None
    return {
      "message": "Local MiniLM classifier retrained.",
      "preserve_experience": preserve_experience,
      "preserve_experience_deprecated": True,
      "status": "completed",
      **training_result,
    }

  def get_training_stats(self) -> dict[str, Any]:
    stats = self.store.get_stats()
    model_status = self.local_model.status()
    model_ready = bool(model_status["ready"]) and self._startup_error is None
    return {
      **stats,
      "model_file": model_status["artifact_path"],
      "model_name": model_status["name"],
      "model_ready": model_ready,
      "model_encoder": model_status["encoder_name"],
      "model_trained_at": model_status["trained_at"],
      "model_validation_skipped": model_status["validation_skipped"],
      "model_error": self._startup_error or model_status["last_error"],
    }

  def _predict(self, task: str, limit: int = 3) -> LocalPrediction:
    try:
      return self.local_model.predict(task, limit=limit)
    except ModelNotReadyError:
      raise
    except Exception as issue:
      self._startup_error = str(issue)
      raise ModelNotReadyError(str(issue)) from issue

  def _extract_tasks_with_tesseract(self, payload: bytes) -> tuple[list[str], str]:
    image = Image.open(BytesIO(payload))
    extracted_text = self.ocr_runner(image, lang=self.settings.tesseract_languages)
    return normalize_extracted_tasks(extracted_text.splitlines()), extracted_text

  def _looks_like_image(self, filename: str, content_type: str | None) -> bool:
    if content_type and content_type.startswith("image/"):
      return True
    guessed_type = mimetypes.guess_type(filename)[0]
    return bool(guessed_type and guessed_type.startswith("image/"))

  def _tesseract_available(self) -> bool:
    return shutil.which("tesseract") is not None
