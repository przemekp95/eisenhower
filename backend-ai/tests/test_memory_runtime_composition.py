import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.config import Settings
from app.memory.runtime import build_memory_runtime


class AIService:
  local_model = object()


def frozen_policy_path() -> Path:
  return Path(__file__).resolve().parents[2] / "docs" / "ai-rebuild" / "memory-policy-v1.json"


def settings(tmp_path, *, policy_path=None, response=False):
  return Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    memory_write_enabled=True,
    memory_retrieval_enabled=True,
    memory_response_enabled=response,
    memory_policy_path=policy_path or frozen_policy_path(),
    memory_consent_hmac_key="m" * 32,
    mongodb_uri="mongodb://mongodb:27017/eisenhower",
    qdrant_url="http://qdrant:6333",
    memory_projection_collection="eisenhower-memory-v1-shadow",
  )


def approved_policy(tmp_path, *, response=False):
  payload = json.loads(frozen_policy_path().read_text(encoding="utf-8"))
  payload["rollout"].update({
    "write_enabled": True,
    "retrieval_enabled": True,
    "response_enabled": response,
    "deployment_authorized": True,
  })
  path = tmp_path / "approved-memory-policy.json"
  path.write_text(json.dumps(payload), encoding="utf-8")
  return path


def test_runtime_rejects_repository_policy_with_rollout_disabled_before_connecting(tmp_path):
  mongo = MagicMock()
  qdrant = MagicMock()

  with pytest.raises(ValueError, match="not policy-approved"):
    build_memory_runtime(
      settings(tmp_path),
      AIService(),
      mongo_client=mongo,
      qdrant_client=qdrant,
    )

  mongo.admin.command.assert_not_called()
  qdrant.get_collection.assert_not_called()


def test_runtime_composes_canonical_mongo_and_separate_rebuildable_projection(tmp_path):
  mongo = MagicMock()
  mongo.admin.command.return_value = {"ok": 1}
  qdrant = MagicMock()
  configured = settings(tmp_path, policy_path=approved_policy(tmp_path))

  runtime = build_memory_runtime(
    configured,
    AIService(),
    mongo_client=mongo,
    qdrant_client=qdrant,
  )

  mongo.admin.command.assert_called_once_with("ping")
  qdrant.get_collection.assert_called_once_with("eisenhower-memory-v1-shadow")
  assert runtime.application.repository.records is mongo[configured.mongodb_database].memory_records
  assert runtime.application.candidate_index.collection_name == "eisenhower-memory-v1-shadow"
  assert runtime.reconciler is not None


def test_runtime_refuses_response_augmentation_even_if_policy_were_to_enable_it(tmp_path):
  configured = settings(
    tmp_path,
    policy_path=approved_policy(tmp_path, response=True),
    response=True,
  )

  with pytest.raises(ValueError, match="response augmentation is not implemented"):
    build_memory_runtime(configured, AIService(), mongo_client=MagicMock())


def test_runtime_rejects_public_projection_endpoint_before_connecting(tmp_path):
  configured = settings(tmp_path, policy_path=approved_policy(tmp_path))
  configured = Settings(**{
    **configured.__dict__,
    "qdrant_url": "https://public.example/qdrant",
  })
  mongo = MagicMock()

  with pytest.raises(ValueError, match="private-network"):
    build_memory_runtime(configured, AIService(), mongo_client=mongo)

  mongo.admin.command.assert_not_called()
