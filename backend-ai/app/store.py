from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import json

from .defaults import DEFAULT_TRAINING_DATA, QUADRANT_NAMES


def utc_now() -> str:
  return datetime.now(tz=timezone.utc).isoformat()


class TrainingStore:
  def __init__(self, path: Path):
    self.path = path
    self.path.parent.mkdir(parents=True, exist_ok=True)

  def load(self) -> list[dict]:
    if not self.path.exists():
      return [dict(item) for item in DEFAULT_TRAINING_DATA]

    with self.path.open("r", encoding="utf-8") as handle:
      return json.load(handle)

  def save(self, items: list[dict]) -> None:
    self.path.parent.mkdir(parents=True, exist_ok=True)
    with self.path.open("w", encoding="utf-8") as handle:
      json.dump(items, handle, ensure_ascii=False, indent=2)

  def add_example(self, text: str, quadrant: int, source: str = "user") -> dict:
    items = self.load()
    record = {
      "text": text,
      "quadrant": quadrant,
      "source": source,
      "timestamp": utc_now(),
    }
    items.append(record)
    self.save(items)
    return record

  def clear(self, keep_defaults: bool) -> list[dict]:
    items = [dict(item) for item in DEFAULT_TRAINING_DATA] if keep_defaults else []
    self.save(items)
    return items

  def get_examples(self, quadrant: int, limit: int = 10) -> list[dict]:
    return [item for item in self.load() if item["quadrant"] == quadrant][:limit]

  def get_stats(self) -> dict:
    items = self.load()
    quadrant_distribution = Counter(str(item["quadrant"]) for item in items)
    source_distribution = Counter(item.get("source", "unknown") for item in items)
    return {
      "total_examples": len(items),
      "quadrant_distribution": dict(quadrant_distribution),
      "data_sources": dict(source_distribution),
      "data_file": str(self.path),
      "model_file": "heuristic-memory",
      "last_updated": utc_now(),
      "quadrant_names": QUADRANT_NAMES,
    }
