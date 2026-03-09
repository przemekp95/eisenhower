from pathlib import Path

from app.provider_state import DEFAULT_PROVIDER_FLAGS, ProviderStateStore


def test_provider_state_store_loads_defaults_and_persists_updates(tmp_path: Path):
  store = ProviderStateStore(tmp_path / "runtime" / "provider_settings.json")

  assert store.load() == DEFAULT_PROVIDER_FLAGS

  store.save({"local_model": False, "tesseract": True})
  assert store.load() == {"local_model": False, "tesseract": True}

  updated = store.set_enabled("tesseract", False)
  assert updated == {"local_model": False, "tesseract": False}
  assert store.load() == {"local_model": False, "tesseract": False}


def test_provider_state_store_falls_back_to_defaults_for_invalid_payloads(tmp_path: Path):
  path = tmp_path / "runtime" / "provider_settings.json"
  store = ProviderStateStore(path)

  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text("{not-json", encoding="utf-8")
  assert store.load() == DEFAULT_PROVIDER_FLAGS

  path.write_text('"invalid"', encoding="utf-8")
  assert store.load() == DEFAULT_PROVIDER_FLAGS

  path.write_text('{"local_model": false, "tesseract": "yes"}', encoding="utf-8")
  assert store.load() == {"local_model": False, "tesseract": True}

  try:
    store.set_enabled("vision", True)
  except ValueError as issue:
    assert str(issue) == "Unknown provider: vision"
  else:
    raise AssertionError("Expected ValueError for an unknown provider.")
