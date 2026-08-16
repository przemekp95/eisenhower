from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
from hmac import compare_digest
from typing import Protocol
from urllib.parse import urlparse


class AuthError(RuntimeError):
  pass


@dataclass(frozen=True)
class AuthPrincipal:
  tenant_id: str
  user_id: str
  roles: list[str] = field(default_factory=list)
  project_ids: list[str] = field(default_factory=list)
  scopes: list[str] = field(default_factory=list)


class TokenVerifier(Protocol):
  def verify(self, token: str) -> AuthPrincipal: ...


def _constant_time_token_match(supplied: str, expected: str) -> bool:
  if not expected:
    return False
  return compare_digest(
    sha256(supplied.encode("utf-8")).digest(),
    sha256(expected.encode("utf-8")).digest(),
  )


class StaticTokenVerifier:
  """Local/dev verifier. Identity never comes from client-controlled headers."""

  def __init__(self, *, user_token: str, admin_token: str):
    self.user_token = user_token
    self.admin_token = admin_token

  def verify(self, token: str) -> AuthPrincipal:
    if _constant_time_token_match(token, self.admin_token):
      return AuthPrincipal(
        "local",
        "local-operator",
        roles=["operator", "admin"],
        scopes=["ai:operate", "ai:analyze", "knowledge:read"],
      )
    if _constant_time_token_match(token, self.user_token):
      return AuthPrincipal("local", "local-user", roles=["user"], scopes=["ai:analyze"])
    raise AuthError("Access denied")


class ServiceTokenVerifier:
  def __init__(self, *, token: str, service_id: str, scopes: list[str]):
    self.token = token
    self.service_id = service_id
    self.scopes = scopes

  def verify(self, token: str) -> AuthPrincipal:
    if not _constant_time_token_match(token, self.token):
      raise AuthError("Access denied")
    return AuthPrincipal(
      tenant_id="service",
      user_id=self.service_id,
      roles=["service"],
      scopes=list(self.scopes),
    )


class OIDCVerifier:
  """JWT verifier backed by a fixed, HTTPS OIDC issuer JWKS endpoint."""

  def __init__(
    self,
    *,
    issuer: str,
    audience: str,
    jwks_url: str | None = None,
    tenant_claim: str = "tenant_id",
    user_claim: str = "sub",
  ):
    issuer_url = urlparse(issuer)
    if issuer_url.scheme != "https" or not issuer_url.hostname:
      raise ValueError("OIDC issuer must be an HTTPS URL")
    if not audience:
      raise ValueError("OIDC audience is required")
    resolved_jwks = jwks_url or f"{issuer.rstrip('/')}/.well-known/jwks.json"
    jwks = urlparse(resolved_jwks)
    if jwks.scheme != "https" or jwks.hostname != issuer_url.hostname:
      raise ValueError("JWKS URL must use HTTPS and the issuer host")
    self.issuer = issuer.rstrip("/")
    self.audience = audience
    self.jwks_url = resolved_jwks
    self.tenant_claim = tenant_claim
    self.user_claim = user_claim
    self._jwk_client = None

  def verify(self, token: str) -> AuthPrincipal:
    try:
      import jwt

      if self._jwk_client is None:
        self._jwk_client = jwt.PyJWKClient(self.jwks_url, cache_keys=True, timeout=3)
      signing_key = self._jwk_client.get_signing_key_from_jwt(token)
      claims = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256", "ES256"],
        audience=self.audience,
        issuer=self.issuer,
        options={"require": ["exp", "iat", "iss", "aud", self.user_claim, self.tenant_claim]},
      )
      tenant_id = str(claims[self.tenant_claim]).strip()
      user_id = str(claims[self.user_claim]).strip()
      if not tenant_id or not user_id:
        raise AuthError("Required identity claim is empty")
      raw_scope = claims.get("scope", "")
      scopes = raw_scope.split() if isinstance(raw_scope, str) else list(raw_scope)
      return AuthPrincipal(
        tenant_id=tenant_id,
        user_id=user_id,
        roles=[str(value) for value in claims.get("roles", [])],
        project_ids=[str(value) for value in claims.get("project_ids", [])],
        scopes=[str(value) for value in scopes],
      )
    except AuthError:
      raise
    except Exception as error:
      raise AuthError("Invalid bearer token") from error
