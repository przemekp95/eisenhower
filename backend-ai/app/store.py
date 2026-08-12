from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from contextlib import contextmanager
import fcntl
import json
import os
import tempfile
import threading

from .defaults import DEFAULT_TRAINING_DATA, QUADRANT_NAMES


def utc_now() -> str:
  return datetime.now(tz=timezone.utc).isoformat()


class TrainingStore:
  def __init__(self, path: Path):
    self.path = path
    self.path.parent.mkdir(parents=True, exist_ok=True)
    self.lock_path = self.path.with_suffix(f"{self.path.suffix}.lock")
    self._thread_lock = threading.RLock()

  def load(self) -> list[dict]:
    with self._file_lock(exclusive=False):
      return self._load_unlocked()

  def _load_unlocked(self) -> list[dict]:
    if not self.path.exists():
      return [dict(item) for item in DEFAULT_TRAINING_DATA]

    with self.path.open("r", encoding="utf-8") as handle:
      return json.load(handle)

  def save(self, items: list[dict]) -> None:
    with self._file_lock(exclusive=True):
      self._save_unlocked(items)

  def _save_unlocked(self, items: list[dict]) -> None:
    self.path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
      dir=self.path.parent,
      prefix=f".{self.path.name}.",
      suffix=".tmp",
      text=True,
    )
    temporary_path = Path(temporary_name)
    try:
      with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(items, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
      os.replace(temporary_path, self.path)
      directory_fd = os.open(self.path.parent, os.O_RDONLY)
      try:
        os.fsync(directory_fd)
      finally:
        os.close(directory_fd)
    finally:
      temporary_path.unlink(missing_ok=True)

  def add_example(self, text: str, quadrant: int, source: str = "user") -> dict:
    record = {
      "text": text,
      "quadrant": quadrant,
      "source": source,
      "timestamp": utc_now(),
    }
    self.add_examples([record])
    return record

  def add_examples(self, records: list[dict]) -> list[dict]:
    if not records:
      return []

    with self._file_lock(exclusive=True):
      items = self._load_unlocked()
      items.extend(records)
      self._save_unlocked(items)
    return records

  def clear(self, keep_defaults: bool) -> list[dict]:
    items = [dict(item) for item in DEFAULT_TRAINING_DATA] if keep_defaults else []
    with self._file_lock(exclusive=True):
      self._save_unlocked(items)
    return items

  @contextmanager
  def _file_lock(self, *, exclusive: bool):
    with self._thread_lock:
      self.lock_path.parent.mkdir(parents=True, exist_ok=True)
      with self.lock_path.open("a+", encoding="utf-8") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        try:
          yield
        finally:
          fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)

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
      "model_file": "",
      "last_updated": utc_now(),
      "quadrant_names": QUADRANT_NAMES,
    }
