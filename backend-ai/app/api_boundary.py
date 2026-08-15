from __future__ import annotations

from ipaddress import ip_address
import logging
import os
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from .audit import AuditAction, AuditEvent, AuditOutcome, SqliteAuditSink
from .auth import AuthError, OIDCVerifier, ServiceTokenVerifier, StaticTokenVerifier
from .config import Settings, load_settings


LOGGER = logging.getLogger("uvicorn.error")
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
PUBLIC_PATHS = {"/", "/metrics", "/health/live", "/health/ready"}
FORWARDED_REQUEST_HEADERS = {
  "accept",
  "authorization",
  "content-type",
  "origin",
  "x-request-id",
}
FORWARDED_RESPONSE_HEADERS = {
  "content-type",
  "retry-after",
  "www-authenticate",
  "x-request-id",
}
MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024


def _private_upstream(url: str, allowed_hosts: tuple[str, ...]) -> bool:
  parsed = urlparse(url)
  if parsed.scheme not in {"http", "https"} or not parsed.hostname:
    return False
  if parsed.username or parsed.password or parsed.query or parsed.fragment:
    return False
  hostname = parsed.hostname.lower().rstrip(".")
  if hostname in {entry.lower().rstrip(".") for entry in allowed_hosts}:
    return True
  if hostname in {"localhost", "127.0.0.1", "::1"}:
    return True
  try:
    return ip_address(hostname).is_private
  except ValueError:
    return "." not in hostname or hostname.endswith((".internal", ".local"))


def create_boundary_app(
  *,
  settings: Settings | None = None,
  classifier_url: str,
  knowledge_url: str | None = None,
  allowed_upstream_hosts: tuple[str, ...] = (),
  client: httpx.AsyncClient | None = None,
) -> FastAPI:
  resolved = settings or load_settings()
  knowledge_url = knowledge_url or classifier_url
  for upstream in {classifier_url, knowledge_url}:
    if not _private_upstream(upstream, allowed_upstream_hosts):
      raise ValueError("AI role upstreams must use fixed private-network URLs")
  classifier_url = classifier_url.rstrip("/")
  knowledge_url = knowledge_url.rstrip("/")
  proxy_client = client or httpx.AsyncClient(
    timeout=httpx.Timeout(connect=2.0, read=35.0, write=10.0, pool=1.0),
    follow_redirects=False,
    limits=httpx.Limits(max_connections=32, max_keepalive_connections=8),
  )
  verifier = (
    OIDCVerifier(
      issuer=str(resolved.oidc_issuer),
      audience=str(resolved.oidc_audience),
      jwks_url=resolved.oidc_jwks_url,
    )
    if resolved.auth_mode == "oidc"
    else StaticTokenVerifier(user_token=resolved.api_token, admin_token=resolved.admin_token)
  )
  internal_verifier = (
    ServiceTokenVerifier(
      token=resolved.internal_api_token,
      service_id="n8n-ingestion",
      scopes=["rag:ingest"],
    )
    if resolved.internal_api_token
    else None
  )
  audit = SqliteAuditSink(
    resolved.audit_database_path,
    hmac_key=resolved.audit_hmac_key.encode("utf-8"),
  )

  app = FastAPI(
    title="Eisenhower AI HTTP Boundary",
    description="Lightweight authenticated boundary for private AI role runtimes.",
  )
  app.add_middleware(
    CORSMiddleware,
    allow_origins=list(resolved.cors_allow_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
  )

  def record(request: Request, action: AuditAction, outcome: AuditOutcome) -> None:
    principal = getattr(request.state, "principal", None)
    audit.record(AuditEvent(
      service="backend-ai-boundary",
      release_sha=resolved.release_sha,
      event_id=uuid4().hex,
      request_id=request.state.request_id,
      action=action,
      outcome=outcome,
      tenant_id=principal.tenant_id if principal else "unknown",
      actor_id=principal.user_id if principal else "anonymous",
      resource_id=request.url.path,
    ))

  @app.middleware("http")
  async def authenticate_and_bind(request: Request, call_next):
    request.state.request_id = request.headers.get("x-request-id") or uuid4().hex
    if request.url.path in PUBLIC_PATHS or request.method == "OPTIONS":
      response = await call_next(request)
      response.headers["X-Request-ID"] = request.state.request_id
      return response
    origin = request.headers.get("origin")
    if origin and request.method in UNSAFE_METHODS and origin not in resolved.cors_allow_origins:
      record(request, AuditAction.ACL_REJECTION, AuditOutcome.REJECTED)
      return JSONResponse(status_code=403, content={"error": "Untrusted browser origin"})
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    try:
      selected_verifier = internal_verifier if request.url.path.startswith("/internal/") else verifier
      if scheme.lower() != "bearer" or not token or selected_verifier is None:
        raise AuthError("Missing bearer authentication")
      request.state.principal = selected_verifier.verify(token)
    except AuthError:
      record(request, AuditAction.AUTH_REJECTION, AuditOutcome.REJECTED)
      return JSONResponse(
        status_code=401,
        content={"error": "Access denied"},
        headers={"WWW-Authenticate": "Bearer"},
      )
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    return response

  @app.get("/")
  async def root():
    return {"service": "Eisenhower AI HTTP Boundary", "status": "ok"}

  @app.get("/health/live")
  async def health_live():
    return {"status": "ok"}

  async def probe(upstream: str) -> bool:
    try:
      response = await proxy_client.get(f"{upstream}/health/ready")
      return response.status_code == 200
    except httpx.HTTPError:
      return False

  @app.get("/health/ready")
  async def health_ready():
    if not await probe(classifier_url):
      return JSONResponse(status_code=503, content={"status": "not_ready", "role": "classifier"})
    if knowledge_url != classifier_url and not await probe(knowledge_url):
      return JSONResponse(status_code=503, content={"status": "not_ready", "role": "knowledge"})
    return {"status": "ready"}

  @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
  async def proxy(path: str, request: Request):
    body = await request.body()
    if len(body) > MAX_PROXY_BODY_BYTES:
      return JSONResponse(status_code=413, content={"error": "Request body is too large"})
    upstream = knowledge_url if path.startswith("v2/knowledge/") else classifier_url
    headers = {
      name: value
      for name, value in request.headers.items()
      if name.lower() in FORWARDED_REQUEST_HEADERS
    }
    headers["X-Request-ID"] = request.state.request_id
    try:
      response = await proxy_client.request(
        request.method,
        f"{upstream}/{path}",
        params=request.query_params,
        content=body,
        headers=headers,
      )
    except httpx.TimeoutException:
      return JSONResponse(status_code=504, content={"error": "Private AI runtime timed out"})
    except httpx.RequestError:
      return JSONResponse(status_code=503, content={"error": "Private AI runtime is unavailable"})
    if 300 <= response.status_code < 400:
      LOGGER.warning("Refusing private AI runtime redirect for %s", path)
      return JSONResponse(status_code=502, content={"error": "Private AI runtime redirect rejected"})
    response_headers = {
      name: value
      for name, value in response.headers.items()
      if name.lower() in FORWARDED_RESPONSE_HEADERS
    }
    return Response(
      content=response.content,
      status_code=response.status_code,
      headers=response_headers,
      media_type=None,
    )

  return app


def from_environment() -> FastAPI:
  classifier_url = os.environ.get("CLASSIFIER_SERVICE_URL", "http://classifier-service:8000")
  knowledge_url = os.environ.get("KNOWLEDGE_SERVICE_URL") or classifier_url
  allowed_hosts = tuple(
    host.strip()
    for host in os.environ.get(
      "AI_ROLE_ALLOWED_HOSTS", "classifier-service,knowledge-service"
    ).split(",")
    if host.strip()
  )
  return create_boundary_app(
    classifier_url=classifier_url,
    knowledge_url=knowledge_url,
    allowed_upstream_hosts=allowed_hosts,
  )
