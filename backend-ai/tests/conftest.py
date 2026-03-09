from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]

if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.config import Settings
from app.local_model import LocalMiniLMClassifier


REAL_RECORDS = [
  {"text": "urgent deadline today", "quadrant": 0, "source": "default"},
  {"text": "critical production incident", "quadrant": 0, "source": "default"},
  {"text": "reply to inbox", "quadrant": 1, "source": "default"},
  {"text": "book meeting room", "quadrant": 1, "source": "default"},
  {"text": "prepare strategic roadmap", "quadrant": 2, "source": "default"},
  {"text": "exercise twice a week", "quadrant": 2, "source": "default"},
  {"text": "scroll social media", "quadrant": 3, "source": "default"},
  {"text": "clean random screenshots", "quadrant": 3, "source": "default"},
]


def build_real_settings(base_dir: Path) -> Settings:
  return Settings(
    training_data_path=base_dir / "training.json",
    model_cache_dir=base_dir / "runtime",
    local_model_epochs=6,
    local_model_patience=2,
  )


@pytest.fixture(scope="session")
def real_encoder():
  from sentence_transformers import SentenceTransformer

  return SentenceTransformer("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")


@pytest.fixture(scope="session")
def real_model_seed_dir(tmp_path_factory: pytest.TempPathFactory, real_encoder) -> Path:
  seed_dir = tmp_path_factory.mktemp("real-minilm-seed")
  settings = build_real_settings(seed_dir)
  settings.training_data_path.write_text(json.dumps(REAL_RECORDS, ensure_ascii=False, indent=2), encoding="utf-8")

  model = LocalMiniLMClassifier(settings=settings, encoder=real_encoder)
  model.ensure_ready(REAL_RECORDS)

  assert model.status()["ready"] is True
  return seed_dir


@pytest.fixture
def real_model_bundle(tmp_path: Path, real_model_seed_dir: Path, real_encoder):
  settings = build_real_settings(tmp_path)
  settings.model_cache_dir.mkdir(parents=True, exist_ok=True)

  for artifact_name in ("local_minilm_head.pt", "local_minilm_meta.json", "local_minilm_index.json"):
    shutil.copy2(real_model_seed_dir / "runtime" / artifact_name, settings.model_cache_dir / artifact_name)

  shutil.copy2(real_model_seed_dir / "training.json", settings.training_data_path)

  return {
    "settings": settings,
    "encoder": real_encoder,
    "records": json.loads(settings.training_data_path.read_text(encoding="utf-8")),
  }
