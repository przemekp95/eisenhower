from pathlib import Path

from app.config import load_settings
import pytest


def test_load_settings_uses_defaults():
  settings = load_settings({
    "EISENHOWER_API_TOKEN": "test-api-token",
    "EISENHOWER_ADMIN_TOKEN": "test-admin-token",
  })

  assert settings.training_data_path.name == "training_data.json"
  assert settings.model_cache_dir.name == "runtime"
  assert "http://127.0.0.1:5173" in settings.cors_allow_origins
  assert settings.admin_token == "test-admin-token"


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
      "EISENHOWER_API_TOKEN": "test-api-token",
      "EISENHOWER_ADMIN_TOKEN": "test-admin-token",
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
  assert settings.api_token == "test-api-token"
  assert settings.admin_token == "test-admin-token"


def test_load_settings_requires_a_long_token_in_production():
  with pytest.raises(ValueError, match="EISENHOWER_API_TOKEN is required"):
    load_settings({"APP_ENV": "production"})

  with pytest.raises(ValueError, match="at least 32 characters"):
    load_settings({
      "APP_ENV": "production",
      "EISENHOWER_API_TOKEN": "too-short",
      "EISENHOWER_ADMIN_TOKEN": "admin-token-that-is-at-least-32-characters",
      "CORS_ALLOW_ORIGINS": "https://tasks.example.com",
    })

  with pytest.raises(ValueError, match="EISENHOWER_ADMIN_TOKEN is required"):
    load_settings({
      "APP_ENV": "production",
      "EISENHOWER_API_TOKEN": "api-token-that-is-at-least-32-characters",
      "CORS_ALLOW_ORIGINS": "https://tasks.example.com",
    })

  with pytest.raises(ValueError, match="must be different"):
    load_settings({
      "APP_ENV": "production",
      "EISENHOWER_API_TOKEN": "same-token-that-is-at-least-32-characters",
      "EISENHOWER_ADMIN_TOKEN": "same-token-that-is-at-least-32-characters",
      "CORS_ALLOW_ORIGINS": "https://tasks.example.com",
    })

  with pytest.raises(ValueError, match="CORS_ALLOW_ORIGINS must list"):
    load_settings({
      "APP_ENV": "production",
      "EISENHOWER_API_TOKEN": "api-token-that-is-at-least-32-characters",
      "EISENHOWER_ADMIN_TOKEN": "admin-token-that-is-at-least-32-characters",
      "CORS_ALLOW_ORIGINS": "",
    })


def test_explicit_empty_cors_allowlist_disables_cross_origin_access():
  settings = load_settings(
    {
      "EISENHOWER_API_TOKEN": "test-api-token",
      "EISENHOWER_ADMIN_TOKEN": "test-admin-token",
      "CORS_ALLOW_ORIGINS": "",
    }
  )

  assert settings.cors_allow_origins == ()
