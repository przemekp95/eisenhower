from pathlib import Path

from fastapi import FastAPI

from main import app


def test_main_exports_fastapi_app():
  assert isinstance(app, FastAPI)


def test_each_http_role_uses_one_worker_for_process_local_runtime_state():
  dockerfile = Path(__file__).parents[1].joinpath("Dockerfile").read_text(encoding="utf-8")

  assert dockerfile.count('"--workers", "1"') == 3
  assert "production-cuda" not in dockerfile
  assert '"--workers", "2"' not in dockerfile
