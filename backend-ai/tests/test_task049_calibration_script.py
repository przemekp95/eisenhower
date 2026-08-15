from hashlib import sha256
import json

import pytest

from scripts.run_task049_calibration import _read_seed
from app.rag.task049_evaluation import build_task050_candidates


class EmptyRetriever:
  def retrieve(self, _query):
    return []


def test_calibration_seed_is_exactly_32_bytes_and_private(tmp_path):
  seed = sha256(b"task049-calibration-test").digest()
  path = tmp_path / "calibration.seed"
  path.write_text(seed.hex(), encoding="utf-8")
  path.chmod(0o600)

  assert _read_seed(path) == seed


def test_calibration_seed_rejects_group_or_world_access(tmp_path):
  path = tmp_path / "calibration.seed"
  path.write_text("00" * 32, encoding="utf-8")
  path.chmod(0o640)

  with pytest.raises(ValueError, match="mode 0600"):
    _read_seed(path)


def test_frozen_policy_is_valid_json_and_commits_both_unrevealed_splits():
  policy_path = (
    __import__("pathlib").Path(__file__).parents[1]
    / "evaluation" / "retrieval-task049-v1" / "policy.json"
  )
  policy = json.loads(policy_path.read_text(encoding="utf-8"))

  assert len(policy["calibration_seed_sha256"]) == 64
  assert len(policy["validation_seed_sha256"]) == 64
  assert policy["calibration_seed_sha256"] != policy["validation_seed_sha256"]


def test_task050_policy_freezes_only_development_candidate_and_keeps_validation_sealed():
  policy_path = (
    __import__("pathlib").Path(__file__).parents[1]
    / "evaluation" / "retrieval-task050-v1" / "policy.json"
  )
  policy = json.loads(policy_path.read_text(encoding="utf-8"))
  _, configurations = build_task050_candidates(EmptyRetriever(), EmptyRetriever())

  assert policy["candidates"] == configurations
  assert policy["validation_seed_must_remain_sealed"] is True
  assert policy["promotion"]["allowed_from_development_result"] is False
  assert policy["development_seed_sha256"] != policy["task049_validation_seed_sha256"]
