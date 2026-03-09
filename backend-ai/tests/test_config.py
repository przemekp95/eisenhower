from pathlib import Path

from app.config import load_settings


def test_load_settings_uses_defaults():
  settings = load_settings({})

  assert settings.training_data_path.name == "training_data.json"
  assert settings.model_cache_dir.name == "runtime"
  assert "http://127.0.0.1:5173" in settings.cors_allow_origins


def test_load_settings_accepts_overrides(tmp_path: Path):
  settings = load_settings(
    {
      "TRAINING_DATA_PATH": str(tmp_path / "examples.json"),
      "MODEL_CACHE_DIR": str(tmp_path / "cache"),
      "LOCAL_MODEL_NAME": "sentence-transformers/test-model",
      "LOCAL_MODEL_HIDDEN_DIM": "96",
      "LOCAL_MODEL_DROPOUT": "0.2",
      "LOCAL_MODEL_EPOCHS": "20",
      "LOCAL_MODEL_PATIENCE": "4",
      "LOCAL_MODEL_LEARNING_RATE": "0.005",
      "TESSERACT_LANGUAGES": "eng",
      "CORS_ALLOW_ORIGINS": "http://example.com,http://127.0.0.1:4173",
    }
  )

  assert settings.training_data_path == tmp_path / "examples.json"
  assert settings.model_cache_dir == tmp_path / "cache"
  assert settings.local_model_name == "sentence-transformers/test-model"
  assert settings.local_model_hidden_dim == 96
  assert settings.local_model_dropout == 0.2
  assert settings.local_model_epochs == 20
  assert settings.local_model_patience == 4
  assert settings.local_model_learning_rate == 0.005
  assert settings.tesseract_languages == "eng"
  assert settings.cors_allow_origins == ("http://example.com", "http://127.0.0.1:4173")
