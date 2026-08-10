from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json

import pytest

from app.store import TrainingStore


def test_store_loads_defaults_when_file_missing(tmp_path: Path):
  store = TrainingStore(tmp_path / "training.json")

  data = store.load()

  assert len(data) >= 4


def test_store_adds_and_filters_examples(tmp_path: Path):
  store = TrainingStore(tmp_path / "training.json")
  store.add_example("Prepare roadmap", 2)
  store.add_example("Urgent outage", 0, source="feedback")
  saved = store.add_examples(
    [
      {"text": "Inbox zero", "quadrant": 1, "source": "ocr-feedback", "timestamp": "2026-03-09T00:00:00+00:00"}
    ]
  )

  examples = store.get_examples(2, limit=5)
  stats = store.get_stats()

  assert saved[0]["source"] == "ocr-feedback"
  assert any(example["text"] == "Prepare roadmap" for example in examples)
  assert stats["data_sources"]["feedback"] == 1
  assert stats["data_sources"]["ocr-feedback"] == 1
  assert store.add_examples([]) == []


def test_store_clear_can_keep_or_drop_defaults(tmp_path: Path):
  store = TrainingStore(tmp_path / "training.json")
  store.add_example("Custom", 1)

  keep_defaults = store.clear(True)
  assert len(keep_defaults) >= 4

  cleared = store.clear(False)
  assert cleared == []


def test_store_serializes_concurrent_read_modify_write_updates(tmp_path: Path):
  store = TrainingStore(tmp_path / "training.json")

  with ThreadPoolExecutor(max_workers=8) as executor:
    list(executor.map(lambda index: store.add_example(f"Concurrent {index}", index % 4), range(40)))

  saved = store.load()
  assert len([item for item in saved if item["text"].startswith("Concurrent ")]) == 40
  json.loads(store.path.read_text(encoding="utf-8"))


def test_store_atomic_save_preserves_previous_json_when_promotion_fails(tmp_path: Path, monkeypatch):
  store = TrainingStore(tmp_path / "training.json")
  store.save([{"text": "incumbent", "quadrant": 0, "source": "test"}])

  monkeypatch.setattr("app.store.os.replace", lambda *_args: (_ for _ in ()).throw(OSError("disk full")))

  with pytest.raises(OSError, match="disk full"):
    store.save([{"text": "candidate", "quadrant": 1, "source": "test"}])

  assert store.load()[0]["text"] == "incumbent"
  assert list(tmp_path.glob(".training.json.*.tmp")) == []
