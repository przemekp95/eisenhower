from __future__ import annotations

from pathlib import Path
import json


DEFAULT_PROVIDER_FLAGS = {
  "local_model": True,
  "tesseract": True,
}


class ProviderStateStore:
  def __init__(self, path: Path):
    self.path = path
    self.path.parent.mkdir(parents=True, exist_ok=True)

  def load(self) -> dict[str, bool]:
    if not self.path.exists():
      return dict(DEFAULT_PROVIDER_FLAGS)

    try:
      with self.path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
      return dict(DEFAULT_PROVIDER_FLAGS)

    if not isinstance(payload, dict):
      return dict(DEFAULT_PROVIDER_FLAGS)

    resolved = dict(DEFAULT_PROVIDER_FLAGS)
    for provider_name in DEFAULT_PROVIDER_FLAGS:
      value = payload.get(provider_name)
      if isinstance(value, bool):
        resolved[provider_name] = value
    return resolved

  def save(self, flags: dict[str, bool]) -> None:
    self.path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
      provider_name: bool(flags.get(provider_name, DEFAULT_PROVIDER_FLAGS[provider_name]))
      for provider_name in DEFAULT_PROVIDER_FLAGS
    }
    with self.path.open("w", encoding="utf-8") as handle:
      json.dump(payload, handle, indent=2)

  def set_enabled(self, provider_name: str, enabled: bool) -> dict[str, bool]:
    if provider_name not in DEFAULT_PROVIDER_FLAGS:
      raise ValueError(f"Unknown provider: {provider_name}")

    flags = self.load()
    flags[provider_name] = enabled
    self.save(flags)
    return flags
