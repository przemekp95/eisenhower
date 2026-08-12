from __future__ import annotations

import asyncio
import json
import socket
import time
from collections.abc import Callable
from threading import Lock
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

import jwt
from mcp.server.auth.provider import AccessToken


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        del new_url
        raise HTTPError(request.full_url, code, message, headers, response)


_OPENER = build_opener(_RejectRedirects())
_MAX_JWKS_BYTES = 256_000


def _https_url(value: str, name: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError(f"{name} must be an HTTPS URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f"{name} must not contain credentials, query parameters, or fragments")
    return value.rstrip("/")


def _fetch_json(url: str, timeout_seconds: float) -> dict[str, Any]:
    request = Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with _OPENER.open(request, timeout=timeout_seconds) as response:
            raw = response.read(_MAX_JWKS_BYTES + 1)
    except (HTTPError, URLError, socket.timeout, TimeoutError) as issue:
        raise RuntimeError("OIDC JWKS is unavailable") from issue
    if len(raw) > _MAX_JWKS_BYTES:
        raise RuntimeError("OIDC JWKS exceeded the configured size limit")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as issue:
        raise RuntimeError("OIDC JWKS returned invalid JSON") from issue
    if not isinstance(value, dict):
        raise RuntimeError("OIDC JWKS returned an invalid document")
    return value


class KeycloakJwtVerifier:
    """Fail-closed RS256 verifier for Keycloak-issued access tokens."""

    def __init__(
        self,
        *,
        issuer: str,
        audience: str,
        jwks_url: str,
        timeout_seconds: float = 3.0,
        cache_ttl_seconds: float = 300.0,
        tenant_claim: str = "tenant_id",
        fetch_json: Callable[[str, float], dict[str, Any]] | None = None,
    ) -> None:
        self.issuer = _https_url(issuer, "OIDC issuer")
        self.audience = audience.strip()
        self.jwks_url = _https_url(jwks_url, "OIDC JWKS URL")
        if not self.audience or timeout_seconds <= 0 or cache_ttl_seconds <= 0:
            raise ValueError("OIDC audience, timeout, and cache TTL must be valid")
        self.tenant_claim = tenant_claim.strip()
        if not self.tenant_claim:
            raise ValueError("OIDC tenant claim must be configured")
        self._timeout_seconds = timeout_seconds
        self._cache_ttl_seconds = cache_ttl_seconds
        self._fetch_json = fetch_json or _fetch_json
        self._cached_jwks: dict[str, Any] | None = None
        self._cached_until = 0.0
        self._lock = Lock()

    async def verify_token(self, token: str) -> AccessToken | None:
        return await asyncio.to_thread(self.verify_token_sync, token)

    def verify_token_sync(self, token: str) -> AccessToken | None:
        try:
            header = jwt.get_unverified_header(token)
            if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
                return None
            key = self._signing_key(header["kid"])
            claims = jwt.decode(
                token,
                key=key,
                algorithms=["RS256"],
                audience=self.audience,
                issuer=self.issuer,
                options={"require": ["exp", "iss", "aud", "sub"]},
            )
            subject = claims.get("sub")
            tenant = claims.get(self.tenant_claim)
            client_id = claims.get("azp", claims.get("client_id"))
            if not all(isinstance(value, str) and 0 < len(value) <= 256 for value in (subject, tenant, client_id)):
                return None
            scope_value = claims.get("scope", "")
            if not isinstance(scope_value, str):
                return None
            scopes = list(dict.fromkeys(scope_value.split()))
            return AccessToken(
                token=token,
                client_id=client_id,
                scopes=scopes,
                expires_at=int(claims["exp"]),
                resource=self.audience,
                subject=subject,
                claims={**claims, "tenant_id": tenant},
            )
        except (jwt.PyJWTError, KeyError, TypeError, ValueError, RuntimeError):
            return None

    def _signing_key(self, kid: str):
        document = self._jwks()
        key = self._find_key(document, kid)
        if key is None:
            document = self._jwks(force_refresh=True)
            key = self._find_key(document, kid)
        if key is None:
            raise RuntimeError("OIDC signing key is unknown")
        return jwt.PyJWK.from_dict(key, algorithm="RS256").key

    @staticmethod
    def _find_key(document: dict[str, Any], kid: str) -> dict[str, Any] | None:
        keys = document.get("keys")
        if not isinstance(keys, list) or len(keys) > 100:
            raise RuntimeError("OIDC JWKS contains an invalid key set")
        for value in keys:
            if (
                isinstance(value, dict)
                and value.get("kid") == kid
                and value.get("kty") == "RSA"
                and value.get("alg", "RS256") == "RS256"
                and value.get("use", "sig") == "sig"
            ):
                return value
        return None

    def _jwks(self, *, force_refresh: bool = False) -> dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            if not force_refresh and self._cached_jwks is not None and now < self._cached_until:
                return self._cached_jwks
            document = self._fetch_json(self.jwks_url, self._timeout_seconds)
            if not isinstance(document, dict):
                raise RuntimeError("OIDC JWKS returned an invalid document")
            self._cached_jwks = document
            self._cached_until = now + self._cache_ttl_seconds
            return document
