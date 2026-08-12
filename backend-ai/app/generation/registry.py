from __future__ import annotations

from pathlib import Path

from .models import PromptSpec


class PromptRegistry:
  def __init__(self, specs: list[PromptSpec]):
    self._specs: dict[tuple[str, str, str], PromptSpec] = {}
    for spec in specs:
      if not spec.verify_checksum():
        raise ValueError(
          f"Prompt artifact checksum mismatch: {spec.prompt_id}/{spec.prompt_version}/{spec.language}"
        )
      key = (spec.prompt_id, spec.prompt_version, spec.language)
      if key in self._specs:
        raise ValueError(f"Duplicate prompt identity: {'/'.join(key)}")
      self._specs[key] = spec
    if not self._specs:
      raise ValueError("Prompt registry must not be empty")

  @classmethod
  def load_directory(cls, directory: str | Path) -> "PromptRegistry":
    source = Path(directory)
    paths = sorted(source.rglob("*.json"))
    if not paths:
      raise ValueError(f"No prompt artifacts found in {source}")
    return cls([PromptSpec.model_validate_json(path.read_text(encoding="utf-8")) for path in paths])

  def get(self, prompt_id: str, prompt_version: str, language: str) -> PromptSpec:
    try:
      return self._specs[(prompt_id, prompt_version, language)]
    except KeyError as error:
      raise KeyError(f"Unknown prompt artifact: {prompt_id}/{prompt_version}/{language}") from error
