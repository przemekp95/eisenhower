from pathlib import Path

import pytest

from app.config import Settings
from app.rag.canonical import CanonicalRetriever
from app.rag.bootstrap import build_rag_service, is_private_mongodb_uri


class LocalModel:
  def encode_text(self, _text):
    return [0.1, 0.2]


class Fallback:
  local_model = LocalModel()


class FakeCollection:
  def create_index(self, *_args, **_kwargs):
    return None

  def find_one(self, _selector):
    return None


class FakeDatabase:
  def __getitem__(self, _name):
    return FakeCollection()


class FakeMongo:
  class Admin:
    @staticmethod
    def command(command):
      assert command == "ping"
      return {"ok": 1}

  admin = Admin()

  def __getitem__(self, _name):
    return FakeDatabase()


class FakeQdrant:
  pass


@pytest.mark.parametrize("uri", [
  "mongodb://mongodb:27017/eisenhower",
  "mongodb://127.0.0.1:27017/eisenhower",
  "mongodb://mongo.internal:27017/eisenhower",
])
def test_private_mongodb_uri_accepts_only_local_network_names(uri):
  assert is_private_mongodb_uri(uri) is True


@pytest.mark.parametrize("uri", [
  "https://mongodb.example.com",
  "mongodb+srv://cluster.mongodb.net/eisenhower",
  "mongodb://8.8.8.8:27017/eisenhower",
])
def test_private_mongodb_uri_rejects_invalid_or_public_endpoints(uri):
  assert is_private_mongodb_uri(uri) is False


def test_rag_bootstrap_fails_closed_without_generator_configuration(tmp_path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_enabled=True,
    rag_retrieval_enabled=True,
    rag_generation_enabled=True,
    inference_api_key=None,
    inference_model=None,
  )

  with pytest.raises(ValueError):
    build_rag_service(settings, Fallback())


def test_rag_bootstrap_supports_retrieval_without_generator_configuration(tmp_path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=False,
    qdrant_url="http://qdrant:6333",
    mongodb_uri="mongodb://mongodb:27017/eisenhower",
    inference_api_key=None,
    inference_model=None,
  )

  service = build_rag_service(
    settings,
    Fallback(),
    qdrant_client=FakeQdrant(),
    mongo_client=FakeMongo(),
  )

  assert service.generation_enabled is False
  assert isinstance(service.retriever, CanonicalRetriever)


def test_rag_bootstrap_fails_closed_without_canonical_mongo_configuration(tmp_path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_retrieval_enabled=True,
    rag_generation_enabled=False,
  )

  with pytest.raises(ValueError, match="MONGODB_URI"):
    build_rag_service(settings, Fallback(), qdrant_client=FakeQdrant())


def test_rag_bootstrap_rejects_public_qdrant_endpoint(tmp_path):
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_enabled=True,
    rag_retrieval_enabled=True,
    rag_generation_enabled=True,
    qdrant_url="https://qdrant.example.com",
    inference_api_key="token",
    inference_model="model",
  )

  with pytest.raises(ValueError):
    build_rag_service(settings, Fallback())


def test_rag_bootstrap_fails_closed_for_unselected_candidate_model(tmp_path):
  prompt_dir = Path(__file__).resolve().parent.parent / "prompts"
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    rag_enabled=True,
    rag_retrieval_enabled=True,
    rag_generation_enabled=True,
    qdrant_url="http://qdrant:6333",
    inference_api_key="token",
    inference_model="__MODEL_SELECTION_REQUIRED__",
    prompt_artifact_dir=prompt_dir,
  )

  with pytest.raises(ValueError, match="model selection"):
    build_rag_service(settings, Fallback())
