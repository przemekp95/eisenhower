from dataclasses import dataclass
from pathlib import Path
import os


def parse_csv_list(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
  if value is None:
    return default

  parsed = tuple(entry.strip() for entry in value.split(",") if entry.strip())
  return parsed or default


@dataclass(frozen=True)
class Settings:
  training_data_path: Path
  model_cache_dir: Path
  openai_api_key: str | None = None
  openai_base_url: str | None = None
  openai_classification_model: str = "gpt-4o-mini"
  openai_reasoning_model: str = "gpt-4o-mini"
  openai_vision_model: str = "gpt-4o-mini"
  openai_embedding_model: str = "text-embedding-3-small"
  openai_timeout_seconds: float = 30.0
  tesseract_languages: str = "eng+pol"
  app_name: str = "AI Quadrant Classifier"
  cors_allow_origins: tuple[str, ...] = (
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
  )


def load_settings(env: dict[str, str] | None = None) -> Settings:
  source = env or os.environ
  base_dir = Path(__file__).resolve().parent.parent

  return Settings(
    training_data_path=Path(
      source.get("TRAINING_DATA_PATH", str(base_dir / "data" / "training_data.json"))
    ),
    model_cache_dir=Path(
      source.get("MODEL_CACHE_DIR", str(base_dir / "data" / "runtime"))
    ),
    openai_api_key=source.get("OPENAI_API_KEY"),
    openai_base_url=source.get("OPENAI_BASE_URL"),
    openai_classification_model=source.get("OPENAI_CLASSIFICATION_MODEL", "gpt-4o-mini"),
    openai_reasoning_model=source.get("OPENAI_REASONING_MODEL", "gpt-4o-mini"),
    openai_vision_model=source.get("OPENAI_VISION_MODEL", "gpt-4o-mini"),
    openai_embedding_model=source.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
    openai_timeout_seconds=float(source.get("OPENAI_TIMEOUT_SECONDS", "30")),
    tesseract_languages=source.get("TESSERACT_LANGUAGES", "eng+pol"),
    cors_allow_origins=parse_csv_list(
      source.get("CORS_ALLOW_ORIGINS"),
      (
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
      ),
    ),
  )
