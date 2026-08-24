#!/usr/bin/env python3
"""Capture the stable FastAPI factory, middleware, and OpenAPI boundary."""

from __future__ import annotations

import inspect
import json
import sys
import tempfile
from pathlib import Path

from fastapi import FastAPI


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402


FIXTURE_PATH = PROJECT_ROOT / "tests" / "fixtures" / "main-openapi-baseline.json"
PUBLIC_IMPORTS = ["app.create_app", "app.main.create_app", "main.app"]


class _UnusedBoundary:
  """Fail if schema construction accidentally initializes a provider boundary."""

  def __getattr__(self, name: str):
    raise AssertionError(f"provider boundary was initialized while building OpenAPI: {name}")


def middleware_contract(application: FastAPI) -> list[dict[str, object]]:
  contract = []
  for middleware in application.user_middleware:
    entry: dict[str, object] = {
      "class": f"{middleware.cls.__module__}.{middleware.cls.__qualname__}",
    }
    dispatch = middleware.kwargs.get("dispatch")
    if dispatch is not None:
      entry["dispatch"] = dispatch.__name__
    options = {
      key: value
      for key, value in middleware.kwargs.items()
      if key != "dispatch"
    }
    if options:
      entry["options"] = options
    contract.append(entry)
  return contract


def build_contract(base_dir: Path) -> dict[str, object]:
  settings = Settings(
    training_data_path=base_dir / "training.json",
    model_cache_dir=base_dir / "runtime",
  )
  application = create_app(
    settings=settings,
    ai_service=_UnusedBoundary(),
    token_verifier=_UnusedBoundary(),
    audit_sink=_UnusedBoundary(),
  )
  return {
    "factory_parameters": list(inspect.signature(create_app).parameters),
    "public_imports": PUBLIC_IMPORTS,
    "middleware": middleware_contract(application),
    "openapi": application.openapi(),
  }


def main() -> None:
  with tempfile.TemporaryDirectory(prefix="eisenhower-fastapi-contract-") as directory:
    contract = build_contract(Path(directory))
  FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
  FIXTURE_PATH.write_text(
    json.dumps(contract, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
  )
  print(f"Captured {len(contract['openapi']['paths'])} FastAPI OpenAPI paths in {FIXTURE_PATH}")


if __name__ == "__main__":
  main()
