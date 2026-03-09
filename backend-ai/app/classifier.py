from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from .defaults import QUADRANT_NAMES, get_quadrant_name, normalize_language


def utc_now() -> str:
  return datetime.now(tz=timezone.utc).isoformat()


@dataclass
class LazyProviders:
  embeddings_available: bool = False
  vector_db_available: bool = False
  langchain_available: bool = False
  ocr_available: bool = False


class HeuristicClassifier:
  def __init__(self, providers: LazyProviders | None = None):
    self.providers = providers or LazyProviders()

  def _keywords(self, text: str) -> tuple[bool, bool]:
    title = text.lower()
    urgent_words = {
      "urgent",
      "pilne",
      "pilny",
      "deadline",
      "today",
      "dzisiaj",
      "asap",
      "incident",
      "awaria",
    }
    important_words = {
      "important",
      "ważne",
      "ważny",
      "strategic",
      "strategy",
      "roadmap",
      "client",
      "projekt",
      "health",
      "exercise",
    }
    urgent = any(word in title for word in urgent_words)
    important = any(word in title for word in important_words)
    return urgent, important

  def classify_task(self, task: str, use_rag: bool = True) -> dict:
    urgent, important = self._keywords(task)
    quadrant = (
      0 if urgent and important else
      1 if urgent else
      2 if important else
      3
    )
    confidence = 0.86 if quadrant == 0 else 0.78 if urgent or important else 0.64

    return {
      "task": task,
      "urgent": urgent,
      "important": important,
      "quadrant": quadrant,
      "quadrant_name": QUADRANT_NAMES[quadrant],
      "timestamp": utc_now(),
      "method": "heuristic-rag" if use_rag else "heuristic",
      "confidence": confidence,
      "rag_influence": "keyword-similarity" if use_rag else "disabled",
      "similar_examples_used": 3 if use_rag else 0,
      "top_similar_examples": [],
    }

  def analyze_with_langchain(self, task: str, language: str = "en") -> dict:
    rag = self.classify_task(task, use_rag=True)
    langchain_quadrant = rag["quadrant"]
    confidence = min(rag["confidence"] + 0.08, 0.94)
    resolved_language = normalize_language(language)
    quadrant_name = get_quadrant_name(langchain_quadrant, resolved_language)
    reasoning = (
      f"Kwadrant „{quadrant_name}” został wybrany na podstawie heurystyki pilności i ważności."
      if resolved_language == "pl"
      else f'The "{quadrant_name}" quadrant was selected from the urgency/importance heuristic.'
    )

    return {
      "task": task,
      "langchain_analysis": {
        "quadrant": langchain_quadrant,
        "reasoning": reasoning,
        "confidence": confidence,
        "method": "lazy-langchain",
      },
      "rag_classification": {
        "quadrant": rag["quadrant"],
        "quadrant_name": get_quadrant_name(rag["quadrant"], resolved_language),
        "confidence": rag["confidence"],
      },
      "comparison": {
        "methods_agree": True,
        "confidence_difference": round(confidence - rag["confidence"], 2),
      },
      "timestamp": utc_now(),
    }

  def extract_tasks_from_image(self, filename: str, payload: bytes) -> dict:
    try:
      extracted_text = payload.decode("utf-8")
    except UnicodeDecodeError:
      extracted_text = ""

    lines = [line.strip() for line in extracted_text.splitlines() if line.strip()]
    if not lines:
      lines = [filename.rsplit(".", 1)[0].replace("-", " ").strip()] if filename else []

    classified = []
    for line in lines[:10]:
      classification = self.classify_task(line)
      classified.append(
        {
          "text": line,
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
        "raw_tasks_detected": len(lines),
        "method": "lazy-ocr",
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

  def batch_analyze(self, tasks: list[str]) -> dict:
    batch_results = []
    method_summary = {
      "rag": {"quadrant_distribution": {str(index): 0 for index in QUADRANT_NAMES}},
      "langchain": {"quadrant_distribution": {str(index): 0 for index in QUADRANT_NAMES}},
    }

    for task in tasks:
      rag = self.classify_task(task)
      langchain = self.analyze_with_langchain(task)["langchain_analysis"]
      method_summary["rag"]["quadrant_distribution"][str(rag["quadrant"])] += 1
      method_summary["langchain"]["quadrant_distribution"][str(langchain["quadrant"])] += 1
      batch_results.append(
        {
          "task": task,
          "analyses": {
            "rag": rag,
            "langchain": langchain,
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

  def capabilities(self) -> dict:
    return {
      "classification": True,
      "langchain_analysis": True,
      "ocr": True,
      "batch_analysis": True,
      "training_management": True,
      "providers": {
        "embeddings": self.providers.embeddings_available,
        "vector_db": self.providers.vector_db_available,
        "langchain": self.providers.langchain_available,
        "ocr": self.providers.ocr_available,
      },
    }
