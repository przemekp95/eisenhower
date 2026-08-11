from dataclasses import dataclass
from pathlib import Path
import math
import os


DEFAULT_PROMPT_ARTIFACT_DIR = Path(__file__).resolve().parent.parent / "prompts"


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
  rag_retrieval_enabled: bool | None = None
  rag_generation_enabled: bool | None = None
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
  prompt_artifact_dir: Path = DEFAULT_PROMPT_ARTIFACT_DIR
  prompt_id: str = "eisenhower-classifier"
  prompt_version: str = "1.1.0"
  retrieval_version: str = "retrieval-v1"
  index_version: str = "index-v1"
  internal_api_token: str | None = None
  internal_allowed_tenants: tuple[str, ...] = ()
  webhook_secret: str | None = None
  jobs_database_path: Path | None = None
  evaluation_data_path: Path | None = None
  mongodb_uri: str | None = None
  mongodb_database: str = "eisenhower"
  canonical_documents_collection: str = "rag_documents"
  corpus_repository_root: Path | None = None
  corpus_manifest_path: Path | None = None
  corpus_owner_id: str = "eisenhower-owner"
  corpus_allowed_projects: tuple[str, ...] = ("eisenhower",)
  memory_write_enabled: bool = False
  memory_retrieval_enabled: bool = False
  memory_response_enabled: bool = False
  memory_policy_path: Path | None = None
  # MinIO Object Storage
  minio_endpoint: str | None = None
  minio_access_key: str | None = None
  minio_secret_key: str | None = None
  minio_bucket: str | None = None
  minio_secure: bool = False
  local_model_name: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
  local_model_revision: str = "e8f8c211226b894fcb81acc59f3b34ba3efd5f42"
  local_model_hidden_dim: int = 128
  local_model_dropout: float = 0.1
  local_model_epochs: int = 60
  local_model_patience: int = 8
  local_model_learning_rate: float = 0.01
  local_model_confidence_threshold: float = 0.55
  local_model_minimum_macro_f1: float = 0.55
  local_model_maximum_ece: float = 0.30
  local_model_maximum_nll: float = 1.20
  local_model_maximum_brier: float = 0.50
  local_model_minimum_per_class_f1: float = 0.50
  local_model_allowed_regression: float = 0.02
  local_model_require_evaluation: bool = False
  local_model_evaluation_profile: str = "development"
  local_model_approved_evaluation_sha256: str | None = None
  local_model_semantic_leakage_threshold: float = 0.92
  local_model_maximum_semantic_leaks: int = 0
  local_model_minimum_language_macro_f1: float = 0.70
  local_model_minimum_selective_accuracy: float = 0.85
  local_model_minimum_automatic_coverage: float = 0.50
  local_model_minimum_worst_seed_macro_f1: float = 0.70
  local_model_maximum_seed_standard_deviation: float = 0.10
  ai_management_enabled: bool = True
  tesseract_languages: str = "eng+pol"
  app_name: str = "AI Quadrant Classifier"
  cors_allow_origins: tuple[str, ...] = (
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
  )

  def __post_init__(self) -> None:
    retrieval_enabled = self.rag_enabled if self.rag_retrieval_enabled is None else self.rag_retrieval_enabled
    generation_enabled = self.rag_enabled if self.rag_generation_enabled is None else self.rag_generation_enabled
    object.__setattr__(self, "rag_retrieval_enabled", retrieval_enabled)
    object.__setattr__(self, "rag_generation_enabled", generation_enabled)
    if generation_enabled and not retrieval_enabled:
      raise ValueError("RAG generation requires RAG retrieval to be enabled.")
    if self.memory_retrieval_enabled and not self.memory_write_enabled:
      raise ValueError("Memory retrieval requires governed memory writes.")
    if self.memory_response_enabled and not self.memory_retrieval_enabled:
      raise ValueError("Memory response augmentation requires memory retrieval.")
    bounded_thresholds = (
      self.local_model_confidence_threshold,
      self.local_model_minimum_macro_f1,
      self.local_model_maximum_ece,
      self.local_model_maximum_brier,
      self.local_model_minimum_per_class_f1,
      self.local_model_allowed_regression,
      self.local_model_semantic_leakage_threshold,
      self.local_model_minimum_language_macro_f1,
      self.local_model_minimum_selective_accuracy,
      self.local_model_minimum_automatic_coverage,
      self.local_model_minimum_worst_seed_macro_f1,
      self.local_model_maximum_seed_standard_deviation,
    )
    if any(not math.isfinite(value) or not 0 <= value <= 1 for value in bounded_thresholds):
      raise ValueError("Every bounded quality threshold must be finite and in range 0..1.")
    if not math.isfinite(self.local_model_maximum_nll) or self.local_model_maximum_nll < 0:
      raise ValueError("Every quality threshold must be finite and non-negative.")
    if self.local_model_evaluation_profile not in {"development", "production"}:
      raise ValueError("Evaluation profile must be 'development' or 'production'.")
    if self.local_model_maximum_semantic_leaks < 0:
      raise ValueError("Every quality threshold count must be non-negative.")
    if self.local_model_approved_evaluation_sha256 is not None:
      digest = self.local_model_approved_evaluation_sha256
      if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise ValueError("Approved evaluation SHA-256 must be a lowercase 64-character hexadecimal digest.")
    if len(self.local_model_revision) != 40 or any(
      character not in "0123456789abcdef" for character in self.local_model_revision
    ):
      raise ValueError("Local model revision must be a lowercase 40-character hexadecimal commit.")
    if self.chunking_version != "chars-1200-overlap-160-v1":
      raise ValueError("Unsupported CHUNKING_VERSION for the configured 1200/160 chunker.")


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
  evaluation_profile = source.get("LOCAL_MODEL_EVALUATION_PROFILE", "development")
  production_profile = evaluation_profile == "production"

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
    rag_retrieval_enabled=(
      source["RAG_RETRIEVAL_ENABLED"].lower() in ("true", "1", "yes")
      if "RAG_RETRIEVAL_ENABLED" in source
      else None
    ),
    rag_generation_enabled=(
      source["RAG_GENERATION_ENABLED"].lower() in ("true", "1", "yes")
      if "RAG_GENERATION_ENABLED" in source
      else None
    ),
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
    prompt_artifact_dir=Path(
      source.get("PROMPT_ARTIFACT_DIR", str(DEFAULT_PROMPT_ARTIFACT_DIR))
    ),
    prompt_id=source.get("PROMPT_ID", "eisenhower-classifier"),
    prompt_version=source.get("PROMPT_VERSION", "1.1.0"),
    retrieval_version=source.get("RETRIEVAL_VERSION", "retrieval-v1"),
    index_version=source.get("INDEX_VERSION", "index-v1"),
    internal_api_token=internal_api_token,
    internal_allowed_tenants=internal_allowed_tenants,
    webhook_secret=source.get("EISENHOWER_WEBHOOK_SECRET") or None,
    jobs_database_path=Path(
      source.get("JOBS_DATABASE_PATH", str(base_dir / "data" / "jobs.sqlite3"))
    ),
    evaluation_data_path=Path(
      source.get("EVALUATION_DATA_PATH", str(base_dir / "data" / "evaluation_v1.json"))
    ),
    mongodb_uri=source.get("MONGODB_URI") or None,
    mongodb_database=source.get("MONGODB_DATABASE", "eisenhower"),
    canonical_documents_collection=source.get("CANONICAL_DOCUMENTS_COLLECTION", "rag_documents"),
    corpus_repository_root=(Path(source["CORPUS_REPOSITORY_ROOT"]) if source.get("CORPUS_REPOSITORY_ROOT") else None),
    corpus_manifest_path=(Path(source["CORPUS_MANIFEST_PATH"]) if source.get("CORPUS_MANIFEST_PATH") else None),
    corpus_owner_id=source.get("CORPUS_OWNER_ID", "eisenhower-owner"),
    memory_write_enabled=source.get("MEMORY_WRITE_ENABLED", "false").lower() in ("true", "1", "yes"),
    memory_retrieval_enabled=source.get("MEMORY_RETRIEVAL_ENABLED", "false").lower() in ("true", "1", "yes"),
    memory_response_enabled=source.get("MEMORY_RESPONSE_ENABLED", "false").lower() in ("true", "1", "yes"),
    memory_policy_path=(Path(source["MEMORY_POLICY_PATH"]) if source.get("MEMORY_POLICY_PATH") else None),
    corpus_allowed_projects=parse_csv_list(source.get("CORPUS_ALLOWED_PROJECTS"), ("eisenhower",)),
    local_model_name=source.get(
      "LOCAL_MODEL_NAME",
      "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    ),
    local_model_revision=source.get(
      "LOCAL_MODEL_REVISION",
      "e8f8c211226b894fcb81acc59f3b34ba3efd5f42",
    ),
    local_model_hidden_dim=int(source.get("LOCAL_MODEL_HIDDEN_DIM", "128")),
    local_model_dropout=float(source.get("LOCAL_MODEL_DROPOUT", "0.1")),
    local_model_epochs=int(source.get("LOCAL_MODEL_EPOCHS", "60")),
    local_model_patience=int(source.get("LOCAL_MODEL_PATIENCE", "8")),
    local_model_learning_rate=float(source.get("LOCAL_MODEL_LEARNING_RATE", "0.01")),
    local_model_confidence_threshold=float(source.get("LOCAL_MODEL_CONFIDENCE_THRESHOLD", "0.55")),
    local_model_minimum_macro_f1=float(source.get("LOCAL_MODEL_MINIMUM_MACRO_F1", "0.80" if production_profile else "0.55")),
    local_model_maximum_ece=float(source.get("LOCAL_MODEL_MAXIMUM_ECE", "0.10" if production_profile else "0.30")),
    local_model_maximum_nll=float(source.get("LOCAL_MODEL_MAXIMUM_NLL", "1.20")),
    local_model_maximum_brier=float(source.get("LOCAL_MODEL_MAXIMUM_BRIER", "0.50")),
    local_model_minimum_per_class_f1=float(source.get("LOCAL_MODEL_MINIMUM_PER_CLASS_F1", "0.72" if production_profile else "0.50")),
    local_model_allowed_regression=float(source.get("LOCAL_MODEL_ALLOWED_REGRESSION", "0.01" if production_profile else "0.02")),
    local_model_require_evaluation=source.get("LOCAL_MODEL_REQUIRE_EVALUATION", "true").lower() in ("true", "1", "yes"),
    local_model_evaluation_profile=evaluation_profile,
    local_model_approved_evaluation_sha256=source.get("LOCAL_MODEL_APPROVED_EVALUATION_SHA256") or None,
    local_model_semantic_leakage_threshold=float(source.get("LOCAL_MODEL_SEMANTIC_LEAKAGE_THRESHOLD", "0.92")),
    local_model_maximum_semantic_leaks=int(source.get("LOCAL_MODEL_MAXIMUM_SEMANTIC_LEAKS", "0")),
    local_model_minimum_language_macro_f1=float(source.get("LOCAL_MODEL_MINIMUM_LANGUAGE_MACRO_F1", "0.77" if production_profile else "0.70")),
    local_model_minimum_selective_accuracy=float(source.get("LOCAL_MODEL_MINIMUM_SELECTIVE_ACCURACY", "0.90" if production_profile else "0.85")),
    local_model_minimum_automatic_coverage=float(source.get("LOCAL_MODEL_MINIMUM_AUTOMATIC_COVERAGE", "0.70" if production_profile else "0.50")),
    local_model_minimum_worst_seed_macro_f1=float(source.get("LOCAL_MODEL_MINIMUM_WORST_SEED_MACRO_F1", "0.75" if production_profile else "0.70")),
    local_model_maximum_seed_standard_deviation=float(source.get("LOCAL_MODEL_MAXIMUM_SEED_STANDARD_DEVIATION", "0.05" if production_profile else "0.10")),
    ai_management_enabled=source.get("AI_MANAGEMENT_ENABLED", "true").lower() in ("true", "1", "yes"),
    tesseract_languages=source.get("TESSERACT_LANGUAGES", "eng+pol"),
    # MinIO Object Storage
    minio_endpoint=source.get("MINIO_ENDPOINT") or None,
    minio_access_key=source.get("MINIO_ACCESS_KEY") or None,
    minio_secret_key=source.get("MINIO_SECRET_KEY") or None,
    minio_bucket=source.get("MINIO_BUCKET") or None,
    minio_secure=source.get("MINIO_SECURE", "false").lower() in ("true", "1", "yes"),
    cors_allow_origins=cors_allow_origins,
  )
