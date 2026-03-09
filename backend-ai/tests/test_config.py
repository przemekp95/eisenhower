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
      "OPENAI_API_KEY": "test-key",
      "OPENAI_BASE_URL": "https://example.invalid/v1",
      "OPENAI_CLASSIFICATION_MODEL": "gpt-test-classify",
      "OPENAI_REASONING_MODEL": "gpt-test-reason",
      "OPENAI_VISION_MODEL": "gpt-test-vision",
      "OPENAI_EMBEDDING_MODEL": "embed-test",
      "OPENAI_TIMEOUT_SECONDS": "12.5",
      "TESSERACT_LANGUAGES": "eng",
      "CORS_ALLOW_ORIGINS": "http://example.com,http://127.0.0.1:4173",
    }
  )

  assert settings.training_data_path == tmp_path / "examples.json"
  assert settings.model_cache_dir == tmp_path / "cache"
  assert settings.openai_api_key == "test-key"
  assert settings.openai_base_url == "https://example.invalid/v1"
  assert settings.openai_classification_model == "gpt-test-classify"
  assert settings.openai_reasoning_model == "gpt-test-reason"
  assert settings.openai_vision_model == "gpt-test-vision"
  assert settings.openai_embedding_model == "embed-test"
  assert settings.openai_timeout_seconds == 12.5
  assert settings.tesseract_languages == "eng"
  assert settings.cors_allow_origins == ("http://example.com", "http://127.0.0.1:4173")
