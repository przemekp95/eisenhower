from pathlib import Path

from app.store import TrainingStore


def test_store_loads_defaults_when_file_missing(tmp_path: Path):
  store = TrainingStore(tmp_path / "training.json")

  data = store.load()

  assert len(data) >= 4


def test_store_adds_and_filters_examples(tmp_path: Path):
  store = TrainingStore(tmp_path / "training.json")
  store.add_example("Prepare roadmap", 2)
  store.add_example("Urgent outage", 0, source="feedback")

  examples = store.get_examples(2, limit=5)
  stats = store.get_stats()

  assert any(example["text"] == "Prepare roadmap" for example in examples)
  assert stats["data_sources"]["feedback"] == 1


def test_store_clear_can_keep_or_drop_defaults(tmp_path: Path):
  store = TrainingStore(tmp_path / "training.json")
  store.add_example("Custom", 1)

  keep_defaults = store.clear(True)
  assert len(keep_defaults) >= 4

  cleared = store.clear(False)
  assert cleared == []
