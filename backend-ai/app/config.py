from dataclasses import dataclass
from pathlib import Path
import os


def parse_csv_list(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
  if value is None:
    return default

  return tuple(entry.strip() for entry in value.split(",") if entry.strip())


@dataclass(frozen=True)
class Settings:
  training_data_path: Path
  model_cache_dir: Path
  api_token: str = "test-api-token"
  admin_token: str = "test-admin-token"
  app_env: str = "development"
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
  # Experimental local LLM settings (llama.cpp).
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
  api_token = source.get("EISENHOWER_API_TOKEN", "")
  admin_token = source.get("EISENHOWER_ADMIN_TOKEN", "")
  cors_allow_origins = parse_csv_list(
    source.get("CORS_ALLOW_ORIGINS"),
    (
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173",
    ),
  )

  if app_env == "production" and not api_token:
    raise ValueError("EISENHOWER_API_TOKEN is required in production.")
  if app_env == "production" and len(api_token) < 32:
    raise ValueError("EISENHOWER_API_TOKEN must be at least 32 characters in production.")
  if app_env == "production" and not admin_token:
    raise ValueError("EISENHOWER_ADMIN_TOKEN is required in production.")
  if app_env == "production" and len(admin_token) < 32:
    raise ValueError("EISENHOWER_ADMIN_TOKEN must be at least 32 characters in production.")
  if api_token and admin_token and api_token == admin_token:
    raise ValueError("EISENHOWER_ADMIN_TOKEN must be different from EISENHOWER_API_TOKEN.")
  if app_env == "production" and not cors_allow_origins:
    raise ValueError(
      "CORS_ALLOW_ORIGINS must list at least one trusted frontend origin in production."
    )

  return Settings(
    training_data_path=Path(
      source.get("TRAINING_DATA_PATH", str(base_dir / "data" / "training_data.json"))
    ),
    model_cache_dir=Path(
      source.get("MODEL_CACHE_DIR", str(base_dir / "data" / "runtime"))
    ),
    api_token=api_token,
    admin_token=admin_token,
    app_env=app_env,
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
