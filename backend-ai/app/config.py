from dataclasses import dataclass
from pathlib import Path
import os


def parse_csv_list(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
  if value is None:
    return default

  parsed = tuple(entry.strip() for entry in value.split(",") if entry.strip())
  return parsed


@dataclass(frozen=True)
class Settings:
  training_data_path: Path
  model_cache_dir: Path
  app_env: str = "development"
  auth_mode: str = "static"
  api_token: str = "test-api-token"
  admin_token: str = "test-admin-token"
  oidc_issuer: str | None = None
  oidc_audience: str | None = None
  oidc_jwks_url: str | None = None
  rag_enabled: bool = False
  rag_response_enabled: bool = True
  rag_allowed_tenants: tuple[str, ...] = ()
  qdrant_url: str = "http://qdrant:6333"
  qdrant_api_key: str | None = None
  qdrant_collection_alias: str = "eisenhower-knowledge-active"
  embedding_version: str = "minilm-v1"
  chunking_version: str = "chars-1200-overlap-160-v1"
  vllm_base_url: str = "http://vllm:8000/v1"
  vllm_api_key: str | None = None
  vllm_model: str | None = None
  internal_api_token: str | None = None
  internal_allowed_tenants: tuple[str, ...] = ()
  webhook_secret: str | None = None
  jobs_database_path: Path | None = None
  # MinIO Object Storage
  minio_endpoint: str | None = None
  minio_access_key: str | None = None
  minio_secret_key: str | None = None
  minio_bucket: str | None = None
  minio_secure: bool = False
  local_model_name: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
  local_model_hidden_dim: int = 128
  local_model_dropout: float = 0.1
  local_model_epochs: int = 60
  local_model_patience: int = 8
  local_model_learning_rate: float = 0.01
  tesseract_languages: str = "eng+pol"
  app_name: str = "AI Quadrant Classifier"
  cors_allow_origins: tuple[str, ...] = (
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
  )
  # Lokalny LLM (llama.cpp)
  llm_enabled: bool = True
  llm_model_filename: str = "llama-3.2-8b-instruct-q4_k_m.gguf"
  llm_quant_level: str = "Q4_K_M"
  llm_n_ctx: int = 2048
  llm_n_threads: int | None = None
  llm_n_gpu_layers: int | None = None
  llm_temperature: float = 0.1
  llm_max_tokens: int = 512


def load_settings(env: dict[str, str] | None = None) -> Settings:
  source = env or os.environ
  base_dir = Path(__file__).resolve().parent.parent
  app_env = source.get("APP_ENV", "development").lower()
  auth_mode = source.get("AUTH_MODE", "static").lower()
  api_token = source.get("EISENHOWER_API_TOKEN", "test-api-token" if app_env != "production" else "")
  admin_token = source.get("EISENHOWER_ADMIN_TOKEN", "test-admin-token" if app_env != "production" else "")
  oidc_issuer = source.get("OIDC_ISSUER") or None
  oidc_audience = source.get("OIDC_AUDIENCE") or None
  cors_allow_origins = parse_csv_list(
    source.get("CORS_ALLOW_ORIGINS"),
    (
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173",
    ),
  )

  if auth_mode not in {"static", "oidc"}:
    raise ValueError("AUTH_MODE must be 'static' or 'oidc'.")
  if app_env == "production" and not cors_allow_origins:
    raise ValueError("CORS_ALLOW_ORIGINS must list trusted browser origins in production.")
  if app_env == "production" and auth_mode == "oidc" and not (oidc_issuer and oidc_audience):
    raise ValueError("OIDC_ISSUER and OIDC_AUDIENCE are required for production OIDC auth.")
  if auth_mode == "static":
    if app_env == "production" and (len(api_token) < 32 or len(admin_token) < 32):
      raise ValueError("Static production tokens must each contain at least 32 characters.")
    if api_token == admin_token:
      raise ValueError("EISENHOWER_ADMIN_TOKEN must differ from EISENHOWER_API_TOKEN.")
  internal_api_token = source.get("EISENHOWER_INTERNAL_API_TOKEN") or None
  internal_allowed_tenants = parse_csv_list(source.get("INTERNAL_ALLOWED_TENANTS"), ())
  if app_env == "production" and internal_api_token and not internal_allowed_tenants:
    raise ValueError("INTERNAL_ALLOWED_TENANTS is required when production ingestion is enabled.")

  return Settings(
    training_data_path=Path(
      source.get("TRAINING_DATA_PATH", str(base_dir / "data" / "training_data.json"))
    ),
    model_cache_dir=Path(
      source.get("MODEL_CACHE_DIR", str(base_dir / "data" / "runtime"))
    ),
    app_env=app_env,
    auth_mode=auth_mode,
    api_token=api_token,
    admin_token=admin_token,
    oidc_issuer=oidc_issuer,
    oidc_audience=oidc_audience,
    oidc_jwks_url=source.get("OIDC_JWKS_URL") or None,
    rag_enabled=source.get("RAG_ENABLED", "false").lower() in ("true", "1", "yes"),
    rag_response_enabled=source.get("RAG_RESPONSE_ENABLED", "true").lower() in ("true", "1", "yes"),
    rag_allowed_tenants=parse_csv_list(source.get("RAG_ALLOWED_TENANTS"), ()),
    qdrant_url=source.get("QDRANT_URL", "http://qdrant:6333"),
    qdrant_api_key=source.get("QDRANT_API_KEY") or None,
    qdrant_collection_alias=source.get(
      "QDRANT_COLLECTION_ALIAS", "eisenhower-knowledge-active"
    ),
    embedding_version=source.get("EMBEDDING_VERSION", "minilm-v1"),
    chunking_version=source.get("CHUNKING_VERSION", "chars-1200-overlap-160-v1"),
    vllm_base_url=source.get("VLLM_BASE_URL", "http://vllm:8000/v1"),
    vllm_api_key=source.get("VLLM_API_KEY") or None,
    vllm_model=source.get("VLLM_MODEL") or None,
    internal_api_token=internal_api_token,
    internal_allowed_tenants=internal_allowed_tenants,
    webhook_secret=source.get("EISENHOWER_WEBHOOK_SECRET") or None,
    jobs_database_path=Path(
      source.get("JOBS_DATABASE_PATH", str(base_dir / "data" / "jobs.sqlite3"))
    ),
    local_model_name=source.get(
      "LOCAL_MODEL_NAME",
      "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    ),
    local_model_hidden_dim=int(source.get("LOCAL_MODEL_HIDDEN_DIM", "128")),
    local_model_dropout=float(source.get("LOCAL_MODEL_DROPOUT", "0.1")),
    local_model_epochs=int(source.get("LOCAL_MODEL_EPOCHS", "60")),
    local_model_patience=int(source.get("LOCAL_MODEL_PATIENCE", "8")),
    local_model_learning_rate=float(source.get("LOCAL_MODEL_LEARNING_RATE", "0.01")),
    tesseract_languages=source.get("TESSERACT_LANGUAGES", "eng+pol"),
    # MinIO Object Storage
    minio_endpoint=source.get("MINIO_ENDPOINT") or None,
    minio_access_key=source.get("MINIO_ACCESS_KEY") or None,
    minio_secret_key=source.get("MINIO_SECRET_KEY") or None,
    minio_bucket=source.get("MINIO_BUCKET") or None,
    minio_secure=source.get("MINIO_SECURE", "false").lower() in ("true", "1", "yes"),
    cors_allow_origins=cors_allow_origins,
  )
