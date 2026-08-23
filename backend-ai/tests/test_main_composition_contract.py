from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI

import app.main as app_main
from scripts.capture_main_openapi import build_contract


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = PROJECT_ROOT / "tests" / "fixtures" / "main-openapi-baseline.json"
FACTORY_PARAMETERS = [
  "settings",
  "store",
  "ai_service",
  "rag_service",
  "token_verifier",
  "metrics_registry",
  "audit_sink",
  "memory_runtime",
]


def test_openapi_matches_the_frozen_fastapi_boundary(tmp_path: Path):
  expected = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

  assert build_contract(tmp_path) == expected
  assert expected["factory_parameters"] == FACTORY_PARAMETERS


def test_public_imports_remain_compatible():
  from app import create_app as package_factory
  from app.main import create_app as module_factory
  from main import app as entrypoint_app

  assert callable(package_factory)
  assert module_factory is app_main.create_app
  assert isinstance(entrypoint_app, FastAPI)


def test_lightweight_app_imports_do_not_load_the_heavy_composition_module():
  completed = subprocess.run(
    [
      sys.executable,
      "-c",
      "import sys, app; assert 'app.main' not in sys.modules; assert callable(app.create_app)",
    ],
    cwd=PROJECT_ROOT,
    check=False,
    capture_output=True,
    text=True,
  )

  assert completed.returncode == 0, completed.stderr


def test_middleware_order_and_options_match_the_frozen_boundary(tmp_path: Path):
  expected = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

  assert build_contract(tmp_path)["middleware"] == expected["middleware"]


def test_main_is_a_compatibility_facade():
  source = Path(app_main.__file__).read_text(encoding="utf-8")

  assert "@app." not in source
  assert "from .http.factory import create_app" in source
