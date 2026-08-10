from pathlib import Path

import pytest

from app.config import Settings, load_settings


def test_load_settings_uses_defaults():
  settings = load_settings({})

  assert settings.training_data_path.name == "training_data.json"
  assert settings.model_cache_dir.name == "runtime"
  assert "http://127.0.0.1:5173" in settings.cors_allow_origins
  assert settings.auth_mode == "static"
  assert settings.rag_enabled is False
  assert settings.prompt_artifact_dir.name == "prompts"
  assert settings.prompt_id == "eisenhower-classifier"
  assert settings.prompt_version == "1.0.0"


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
      "PROMPT_ARTIFACT_DIR": str(tmp_path / "prompts"),
      "PROMPT_ID": "custom-classifier",
      "PROMPT_VERSION": "2.1.0",
      "RETRIEVAL_VERSION": "retrieval-v2",
      "INDEX_VERSION": "index-v3",
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
  assert settings.prompt_artifact_dir == tmp_path / "prompts"
  assert settings.prompt_id == "custom-classifier"
  assert settings.prompt_version == "2.1.0"
  assert settings.retrieval_version == "retrieval-v2"
  assert settings.index_version == "index-v3"


def test_production_oidc_requires_issuer_audience_and_explicit_cors():
  with pytest.raises(ValueError):
    load_settings({"APP_ENV": "production", "AUTH_MODE": "oidc", "CORS_ALLOW_ORIGINS": ""})

  settings = load_settings(
    {
      "APP_ENV": "production",
      "AUTH_MODE": "oidc",
      "OIDC_ISSUER": "https://identity.example.com",
      "OIDC_AUDIENCE": "eisenhower-api",
      "CORS_ALLOW_ORIGINS": "https://app.example.com",
      "RAG_ENABLED": "true",
      "QDRANT_URL": "http://qdrant:6333",
      "VLLM_BASE_URL": "http://vllm:8000/v1",
      "VLLM_API_KEY": "private-token",
      "VLLM_MODEL": "approved-model",
      "RAG_RESPONSE_ENABLED": "false",
      "RAG_ALLOWED_TENANTS": "tenant-a,tenant-b",
    }
  )

  assert settings.auth_mode == "oidc"
  assert settings.rag_enabled is True
  assert settings.qdrant_collection_alias == "eisenhower-knowledge-active"
  assert settings.rag_response_enabled is False
  assert settings.rag_allowed_tenants == ("tenant-a", "tenant-b")


def test_production_static_auth_requires_distinct_long_tokens():
  with pytest.raises(ValueError):
    load_settings(
      {
        "APP_ENV": "production",
        "AUTH_MODE": "static",
        "EISENHOWER_API_TOKEN": "short",
        "EISENHOWER_ADMIN_TOKEN": "short",
        "CORS_ALLOW_ORIGINS": "https://app.example.com",
      }
    )


@pytest.mark.parametrize(
  ("field", "value"),
  [
    ("local_model_confidence_threshold", float("nan")),
    ("local_model_minimum_macro_f1", -0.1),
    ("local_model_maximum_ece", 1.1),
    ("local_model_allowed_regression", float("inf")),
    ("local_model_semantic_leakage_threshold", 1.1),
  ],
)
def test_settings_reject_invalid_quality_gate_thresholds(tmp_path: Path, field: str, value: float):
  kwargs = {
    "training_data_path": tmp_path / "training.json",
    "model_cache_dir": tmp_path / "runtime",
    field: value,
  }

  with pytest.raises(ValueError, match="quality threshold"):
    Settings(**kwargs)


def test_loaded_settings_require_evaluation_and_support_explicit_production_profile():
  settings = load_settings({"LOCAL_MODEL_EVALUATION_PROFILE": "production"})

  assert settings.local_model_require_evaluation is True
  assert settings.local_model_evaluation_profile == "production"


def test_settings_reject_malformed_approved_evaluation_digest(tmp_path: Path):
  with pytest.raises(ValueError, match="SHA-256"):
    Settings(
      training_data_path=tmp_path / "training.json",
      model_cache_dir=tmp_path / "runtime",
      local_model_approved_evaluation_sha256="not-a-digest",
    )
