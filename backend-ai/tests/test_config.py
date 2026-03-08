from pathlib import Path

from app.config import load_settings


def test_load_settings_uses_defaults():
  settings = load_settings({})

  assert settings.training_data_path.name == "training_data.json"
  assert settings.model_cache_dir.name == "runtime"


def test_load_settings_accepts_overrides(tmp_path: Path):
  settings = load_settings(
    {
      "TRAINING_DATA_PATH": str(tmp_path / "examples.json"),
      "MODEL_CACHE_DIR": str(tmp_path / "cache"),
    }
  )

  assert settings.training_data_path == tmp_path / "examples.json"
  assert settings.model_cache_dir == tmp_path / "cache"
