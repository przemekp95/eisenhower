from __future__ import annotations

from dataclasses import dataclass
from ipaddress import ip_address
import os
import re
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware


_MAX_REQUEST_BYTES = 8 * 1024 * 1024
_SAFE_RESPONSE_HEADERS = ("content-type", "x-request-id", "retry-after")
_ROUTES = (
  ("POST", re.compile(r"^v2/(?:ai/analyze|knowledge/(?:search|answer))$")),
  ("POST", re.compile(r"^(?:classify|analyze|extract-tasks-from-image|batch-analyze)$")),
  ("POST", re.compile(r"^(?:add-example|retrain|learn-feedback|learn-ocr-feedback)$")),
  ("GET", re.compile(r"^(?:training-stats|capabilities|examples/[^/]+)$")),
  ("DELETE", re.compile(r"^training-data$")),
  ("PUT", re.compile(r"^providers/[^/]+$")),
)


@dataclass(frozen=True)
class BoundarySettings:
  knowledge_base_url: str
  knowledge_allowed_hosts: tuple[str, ...]
  cors_allow_origins: tuple[str, ...]


def _private_host(hostname: str) -> bool:
  if hostname in {"localhost", "127.0.0.1", "::1"}:
    return True
  try:
    return ip_address(hostname).is_private
  except ValueError:
    return "." not in hostname or hostname.endswith((".internal", ".local"))


class PrivateKnowledgeProvider:
  """Fixed-destination HTTP adapter; user identity remains the original bearer."""

  def __init__(
    self,
    *,
    base_url: str,
    allowed_hosts: tuple[str, ...],
    transport: httpx.BaseTransport | None = None,
  ):
    parsed = urlparse(base_url)
    hostname = (parsed.hostname or "").lower()
    normalized_hosts = {host.lower() for host in allowed_hosts}
    if parsed.scheme not in {"http", "https"} or not hostname or not _private_host(hostname):
      raise ValueError("knowledge provider must use a fixed private HTTP URL")
    if hostname not in normalized_hosts:
      raise ValueError("knowledge provider host is not allowlisted")
    self.client = httpx.Client(
      base_url=base_url.rstrip("/") + "/",
      follow_redirects=False,
      timeout=httpx.Timeout(connect=2.0, read=30.0, write=10.0, pool=1.0),
      transport=transport,
    )

  def forward(self, *, method: str, path: str, headers: dict[str, str], body: bytes) -> httpx.Response:
    return self.client.request(method, path, headers=headers, content=body)

  def live(self) -> bool:
    try:
      response = self.client.get("health/live")
    except httpx.HTTPError:
      return False
    return response.status_code == 200


def _is_allowed(method: str, path: str) -> bool:
  return any(route_method == method and pattern.fullmatch(path) for route_method, pattern in _ROUTES)


def create_boundary_app(
  settings: BoundarySettings,
  *,
  provider: PrivateKnowledgeProvider | None = None,
) -> FastAPI:
  knowledge = provider or PrivateKnowledgeProvider(
    base_url=settings.knowledge_base_url,
    allowed_hosts=settings.knowledge_allowed_hosts,
  )
  trusted_origins = set(settings.cors_allow_origins)
  app = FastAPI(title="Eisenhower AI boundary", docs_url=None, redoc_url=None, openapi_url=None)
  app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_allow_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
  )

  @app.get("/health/live", include_in_schema=False)
  def health_live() -> dict[str, str]:
    return {"status": "live"}

  @app.get("/health/ready", include_in_schema=False)
  def health_ready() -> dict[str, str]:
    if not knowledge.live():
      raise HTTPException(status_code=503, detail="private knowledge service unavailable")
    return {"status": "ready"}

  @app.get("/metrics", include_in_schema=False)
  def metrics() -> Response:
    upstream_live = 1 if knowledge.live() else 0
    body = (
      "# TYPE eisenhower_ai_boundary_info gauge\n"
      "eisenhower_ai_boundary_info 1\n"
      "# TYPE eisenhower_ai_boundary_upstream_live gauge\n"
      f"eisenhower_ai_boundary_upstream_live {upstream_live}\n"
    )
    return Response(content=body, media_type="text/plain; version=0.0.4")

  @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"], include_in_schema=False)
  async def proxy(path: str, request: Request) -> Response:
    if not _is_allowed(request.method, path):
      raise HTTPException(status_code=404, detail="route is not exposed by the boundary")
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer ") or not authorization[7:].strip():
      raise HTTPException(status_code=401, detail="Bearer authorization is required")
    origin = request.headers.get("origin")
    if request.method in {"POST", "PUT", "DELETE"} and origin and origin not in trusted_origins:
      raise HTTPException(status_code=403, detail="Origin is not trusted")
    body = await request.body()
    if len(body) > _MAX_REQUEST_BYTES:
      raise HTTPException(status_code=413, detail="request body is too large")
    outbound_headers = {"authorization": authorization}
    for name in ("content-type", "x-request-id"):
      if value := request.headers.get(name):
        outbound_headers[name] = value
    try:
      upstream = knowledge.forward(
        method=request.method,
        path=path,
        headers=outbound_headers,
        body=body,
      )
    except httpx.HTTPError as error:
      raise HTTPException(status_code=503, detail="private knowledge service unavailable") from error
    if 300 <= upstream.status_code < 400:
      raise HTTPException(status_code=502, detail="private knowledge service returned a redirect")
    response_headers = {
      name: value for name, value in upstream.headers.items() if name.lower() in _SAFE_RESPONSE_HEADERS
    }
    return Response(content=upstream.content, status_code=upstream.status_code, headers=response_headers)

  return app


def from_environment() -> FastAPI:
  base_url = os.environ.get("KNOWLEDGE_SERVICE_BASE_URL", "").strip()
  allowed_hosts = tuple(
    item.strip() for item in os.environ.get("KNOWLEDGE_SERVICE_ALLOWED_HOSTS", "").split(",") if item.strip()
  )
  origins = tuple(
    item.strip() for item in os.environ.get("CORS_ALLOW_ORIGINS", "").split(",") if item.strip()
  )
  if not base_url or not allowed_hosts or not origins:
    raise ValueError("knowledge URL, allowed hosts and CORS origins are required")
  return create_boundary_app(BoundarySettings(base_url, allowed_hosts, origins))
