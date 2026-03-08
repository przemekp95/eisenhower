from fastapi import FastAPI

from main import app


def test_main_exports_fastapi_app():
  assert isinstance(app, FastAPI)
