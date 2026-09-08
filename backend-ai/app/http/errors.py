from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from ..local_model import ModelNotReadyError
from ..service import ProviderDisabledError
from .composition import AppDependencies


def register_exception_handlers(app: FastAPI, _deps: AppDependencies) -> None:
  @app.exception_handler(HTTPException)
  async def http_exception_handler(_request, exception: HTTPException):
    return JSONResponse(status_code=exception.status_code, content={"error": exception.detail})

  @app.exception_handler(ModelNotReadyError)
  async def model_not_ready_handler(_request, exception: ModelNotReadyError):
    return JSONResponse(
      status_code=503,
      content={"error": str(exception), "code": "model_not_ready"},
    )

  @app.exception_handler(ProviderDisabledError)
  async def provider_disabled_handler(_request, exception: ProviderDisabledError):
    return JSONResponse(
      status_code=503,
      content={"error": str(exception), "code": "provider_disabled"},
    )
