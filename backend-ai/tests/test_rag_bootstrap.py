import pytest

from app.config import Settings
from app.rag.bootstrap import build_rag_service


class LocalModel:
  def encode_text(self, text):
    return [0.1, 0.2]


class Fallback:
  local_model = LocalModel()


def test_rag_bootstrap_fails_closed_without_generator_configuration(tmp_path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_enabled=True,
    vllm_api_key=None,
    vllm_model=None,
  )

  with pytest.raises(ValueError):
    build_rag_service(settings, Fallback())


def test_rag_bootstrap_rejects_public_qdrant_endpoint(tmp_path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_enabled=True,
    qdrant_url="https://qdrant.example.com",
    vllm_api_key="token",
    vllm_model="model",
  )

  with pytest.raises(ValueError):
    build_rag_service(settings, Fallback())
