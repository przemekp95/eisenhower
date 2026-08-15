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
  assert settings.rag_retrieval_enabled is False
  assert settings.rag_generation_enabled is False
  assert settings.rag_response_enabled is False
  assert not settings.rag_response_allowed_users
  assert settings.rag_retrieval_strategy == "hybrid-bge-v1"
  assert settings.chunking_version == settings.llamaindex_pipeline_version
  assert settings.llamaindex_candidate_collection.endswith("-candidate")
  assert settings.reranker_base_url == "http://reranker:8000"
  assert settings.reranker_api_key is None
  assert settings.memory_write_enabled is False
  assert settings.memory_retrieval_enabled is False
  assert settings.memory_response_enabled is False
  assert settings.audit_database_path.name == "audit.sqlite3"
  assert settings.release_sha == "0" * 40
  assert settings.inference_base_url == "http://inference:8000/v1"
  assert settings.inference_api_key is None
  assert settings.inference_model is None
  assert settings.inference_connect_timeout_seconds == 2.0
  assert settings.inference_read_timeout_seconds == 15.0
  assert settings.prompt_artifact_dir.name == "prompts"
  assert settings.prompt_id == "eisenhower-classifier"
  assert settings.prompt_version == "1.1.0"
  assert settings.local_model_revision == "e8f8c211226b894fcb81acc59f3b34ba3efd5f42"
  assert settings.rag_embedding_model_name is None
  assert settings.rag_embedding_model_revision is None
  assert settings.mongodb_uri is None
  assert settings.canonical_documents_collection == "rag_documents"
  assert settings.memory_write_enabled is False
  assert settings.memory_retrieval_enabled is False
  assert settings.memory_response_enabled is False


def test_load_settings_accepts_overrides(tmp_path: Path):
  settings = load_settings(
    {
      "TRAINING_DATA_PATH": str(tmp_path / "examples.json"),
      "MODEL_CACHE_DIR": str(tmp_path / "cache"),
      "LOCAL_MODEL_NAME": "sentence-transformers/test-model",
      "LOCAL_MODEL_REVISION": "0123456789abcdef0123456789abcdef01234567",
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
      "RAG_RETRIEVAL_ENABLED": "true",
      "RAG_GENERATION_ENABLED": "false",
      "RAG_EMBEDDING_MODEL_NAME": "BAAI/bge-m3",
      "RAG_EMBEDDING_MODEL_REVISION": "5617a9f61b028005a4858fdac845db406aefb181",
      "RAG_EMBEDDING_DEVICE": "cuda",
      "RAG_RETRIEVAL_STRATEGY": "dense-v1",
      "LLAMAINDEX_CANDIDATE_COLLECTION": "eisenhower-knowledge-llama-v2-candidate",
      "LLAMAINDEX_PIPELINE_VERSION": "llama-sentence-512-64-v2",
      "RERANKER_BASE_URL": "http://reranker.internal:8000",
      "RERANKER_API_KEY": "reranker-token",
      "RERANKER_ALLOWED_HOSTS": "reranker.internal",
      "INFERENCE_BASE_URL": "https://gpu.mesh.example/v1",
      "INFERENCE_API_KEY": "service-token",
      "INFERENCE_MODEL": "approved-model",
      "INFERENCE_ALLOWED_HOSTS": "gpu.mesh.example,gpu-backup.mesh.example",
      "INFERENCE_CONNECT_TIMEOUT_SECONDS": "1.5",
      "INFERENCE_READ_TIMEOUT_SECONDS": "12.5",
      "INFERENCE_WRITE_TIMEOUT_SECONDS": "3.5",
      "INFERENCE_POOL_TIMEOUT_SECONDS": "0.5",
      "INFERENCE_CIRCUIT_FAILURE_THRESHOLD": "4",
      "INFERENCE_CIRCUIT_RESET_SECONDS": "45",
      "MONGODB_URI": "mongodb://mongodb:27017/eisenhower",
      "MONGODB_DATABASE": "eisenhower-test",
      "CANONICAL_DOCUMENTS_COLLECTION": "canonical-test",
      "CORPUS_REPOSITORY_ROOT": str(tmp_path / "corpus"),
      "CORPUS_MANIFEST_PATH": str(tmp_path / "manifest.json"),
      "CORPUS_OWNER_ID": "owner-1",
      "MEMORY_WRITE_ENABLED": "true",
      "MEMORY_RETRIEVAL_ENABLED": "true",
      "MEMORY_RESPONSE_ENABLED": "false",
      "MEMORY_POLICY_PATH": str(tmp_path / "memory-policy.json"),
      "AUDIT_DATABASE_PATH": str(tmp_path / "security-audit.sqlite3"),
      "AUDIT_HMAC_KEY": "a" * 32,
      "RELEASE_SHA": "1" * 40,
    }
  )

  assert settings.training_data_path == tmp_path / "examples.json"
  assert settings.chunking_version == "llama-sentence-512-64-v2"
  assert settings.llamaindex_candidate_collection == "eisenhower-knowledge-llama-v2-candidate"
  assert settings.model_cache_dir == tmp_path / "cache"
  assert settings.local_model_name == "sentence-transformers/test-model"
  assert settings.local_model_revision == "0123456789abcdef0123456789abcdef01234567"
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
  assert settings.rag_retrieval_enabled is True
  assert settings.rag_generation_enabled is False
  assert settings.rag_embedding_model_name == "BAAI/bge-m3"
  assert settings.rag_embedding_model_revision == "5617a9f61b028005a4858fdac845db406aefb181"
  assert settings.rag_embedding_device == "cuda"
  assert settings.rag_retrieval_strategy == "dense-v1"
  assert settings.reranker_base_url == "http://reranker.internal:8000"
  assert settings.reranker_api_key == "reranker-token"
  assert settings.reranker_allowed_hosts == ("reranker.internal",)
  assert settings.inference_base_url == "https://gpu.mesh.example/v1"
  assert settings.inference_api_key == "service-token"
  assert settings.inference_model == "approved-model"
  assert settings.inference_allowed_hosts == ("gpu.mesh.example", "gpu-backup.mesh.example")
  assert settings.inference_connect_timeout_seconds == 1.5
  assert settings.inference_read_timeout_seconds == 12.5
  assert settings.inference_write_timeout_seconds == 3.5
  assert settings.inference_pool_timeout_seconds == 0.5
  assert settings.inference_circuit_failure_threshold == 4
  assert settings.inference_circuit_reset_seconds == 45
  assert settings.mongodb_uri == "mongodb://mongodb:27017/eisenhower"
  assert settings.mongodb_database == "eisenhower-test"
  assert settings.canonical_documents_collection == "canonical-test"
  assert settings.corpus_repository_root == tmp_path / "corpus"
  assert settings.corpus_manifest_path == tmp_path / "manifest.json"
  assert settings.corpus_owner_id == "owner-1"
  assert settings.memory_write_enabled is True
  assert settings.memory_retrieval_enabled is True
  assert settings.memory_response_enabled is False
  assert settings.memory_policy_path == tmp_path / "memory-policy.json"
  assert settings.audit_database_path == tmp_path / "security-audit.sqlite3"
  assert settings.audit_hmac_key == "a" * 32
  assert settings.release_sha == "1" * 40


def test_load_settings_accepts_legacy_vllm_environment_as_compatibility_input():
  settings = load_settings(
    {
      "VLLM_BASE_URL": "http://legacy-vllm.internal:8000/v1",
      "VLLM_API_KEY": "legacy-token",
      "VLLM_MODEL": "legacy-model",
    }
  )

  assert settings.inference_base_url == "http://legacy-vllm.internal:8000/v1"
  assert settings.inference_api_key == "legacy-token"
  assert settings.inference_model == "legacy-model"


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
      "AUDIT_HMAC_KEY": "a" * 32,
      "RELEASE_SHA": "1" * 40,
    }
  )

  assert settings.auth_mode == "oidc"
  assert settings.rag_enabled is True
  assert settings.rag_retrieval_enabled is True
  assert settings.rag_generation_enabled is True
  assert settings.qdrant_collection_alias == "eisenhower-knowledge-active"
  assert settings.rag_response_enabled is False
  assert settings.rag_allowed_tenants == ("tenant-a", "tenant-b")


def test_generation_cannot_be_enabled_without_retrieval(tmp_path: Path):
  with pytest.raises(ValueError, match="retrieval"):
    Settings(
      training_data_path=tmp_path / "training.json",
      model_cache_dir=tmp_path / "runtime",
      rag_generation_enabled=True,
    )


def test_production_response_canary_requires_explicit_tenant_and_user_cohorts(tmp_path: Path):
  common = {
    "training_data_path": tmp_path / "training.json",
    "model_cache_dir": tmp_path / "runtime",
    "app_env": "production",
    "rag_retrieval_enabled": True,
    "rag_generation_enabled": True,
    "rag_response_enabled": True,
  }
  with pytest.raises(ValueError, match="tenant and user allowlists"):
    Settings(**common)
  with pytest.raises(ValueError, match="promotion pointer"):
    Settings(
      **common,
      rag_allowed_tenants=("owner-tenant",),
      rag_response_allowed_users=("owner-sub",),
    )
  settings = Settings(
    **common,
    rag_allowed_tenants=("owner-tenant",),
    rag_response_allowed_users=("owner-sub",),
    rag_response_promotion_pointer_path=tmp_path / "promotion" / "current.json",
    rag_response_candidate_id="answer-v1",
  )
  assert settings.rag_response_allowed_users == ("owner-sub",)


def test_unknown_retrieval_strategy_fails_closed(tmp_path: Path):
  with pytest.raises(ValueError, match="RAG_RETRIEVAL_STRATEGY"):
    Settings(
      training_data_path=tmp_path / "training.json",
      model_cache_dir=tmp_path / "runtime",
      rag_retrieval_strategy="silent-dense-fallback",
    )


def test_memory_flags_fail_closed_in_rollout_order(tmp_path: Path):
  common = {
    "training_data_path": tmp_path / "training.json",
    "model_cache_dir": tmp_path / "runtime",
  }
  with pytest.raises(ValueError, match="governed memory writes"):
    Settings(**common, memory_retrieval_enabled=True)
  with pytest.raises(ValueError, match="memory retrieval"):
    Settings(**common, memory_write_enabled=True, memory_response_enabled=True)


def test_production_static_auth_requires_distinct_long_tokens():
  with pytest.raises(ValueError):
    load_settings(
      {
        "APP_ENV": "production",
        "AUTH_MODE": "static",
        "EISENHOWER_API_TOKEN": "short",
        "EISENHOWER_ADMIN_TOKEN": "short",
        "CORS_ALLOW_ORIGINS": "https://app.example.com",
        "AUDIT_HMAC_KEY": "a" * 32,
        "RELEASE_SHA": "1" * 40,
      }
    )


def test_production_requires_separate_audit_key_and_immutable_release_sha():
  common = {
    "APP_ENV": "production",
    "AUTH_MODE": "static",
    "EISENHOWER_API_TOKEN": "u" * 32,
    "EISENHOWER_ADMIN_TOKEN": "a" * 32,
    "CORS_ALLOW_ORIGINS": "https://app.example.com",
  }

  with pytest.raises(ValueError, match="AUDIT_HMAC_KEY"):
    load_settings(common)
  with pytest.raises(ValueError, match="RELEASE_SHA"):
    load_settings({**common, "AUDIT_HMAC_KEY": "k" * 32})

  settings = load_settings(
    {**common, "AUDIT_HMAC_KEY": "k" * 32, "RELEASE_SHA": "1" * 40}
  )

  assert settings.release_sha == "1" * 40


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
