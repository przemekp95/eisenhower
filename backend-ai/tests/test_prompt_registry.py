import json
from pathlib import Path

import pytest

from test_generation_contract import _prompt_spec

from app.generation.registry import PromptRegistry


def test_registry_loads_pl_and_en_variants_and_rejects_checksum_drift(tmp_path):
  pl = _prompt_spec(language="pl")
  en = _prompt_spec(language="en", system_template="System rules in English")
  (tmp_path / "pl.json").write_text(pl.model_dump_json(indent=2), encoding="utf-8")
  (tmp_path / "en.json").write_text(en.model_dump_json(indent=2), encoding="utf-8")

  registry = PromptRegistry.load_directory(tmp_path)

  assert registry.get("eisenhower-classifier", "1.0.0", "pl") == pl
  assert registry.get("eisenhower-classifier", "1.0.0", "en") == en

  payload = json.loads((tmp_path / "pl.json").read_text(encoding="utf-8"))
  payload["system_template"] = "silently changed"
  (tmp_path / "pl.json").write_text(json.dumps(payload), encoding="utf-8")
  with pytest.raises(ValueError, match="checksum"):
    PromptRegistry.load_directory(tmp_path)


def test_registry_rejects_duplicate_prompt_identity():
  spec = _prompt_spec()
  with pytest.raises(ValueError, match="Duplicate"):
    PromptRegistry([spec, spec])


def test_repository_prompt_artifacts_are_the_same_checksum_verified_variants_runtime_loads():
  prompt_dir = Path(__file__).resolve().parent.parent / "prompts"

  registry = PromptRegistry.load_directory(prompt_dir)
  pl = registry.get("eisenhower-classifier", "1.0.0", "pl")
  en = registry.get("eisenhower-classifier", "1.0.0", "en")

  assert pl.verify_checksum() and en.verify_checksum()
  assert pl.domain_rules_version == en.domain_rules_version
  assert pl.tie_break_rules_version == en.tie_break_rules_version
  assert pl.output_schema_version == en.output_schema_version
  assert pl.status == en.status == "candidate"
