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
