from dataclasses import dataclass
from pathlib import Path
import os


@dataclass(frozen=True)
class Settings:
  training_data_path: Path
  model_cache_dir: Path
  app_name: str = "AI Quadrant Classifier"


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
  )
