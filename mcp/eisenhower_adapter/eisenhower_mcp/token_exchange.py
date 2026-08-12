from __future__ import annotations

import base64
import hashlib
import json
import socket
import time
from collections import OrderedDict
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from mcp.server.auth.provider import AccessToken

from .oidc import KeycloakJwtVerifier, _https_url


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        del new_url
        raise HTTPError(request.full_url, code, message, headers, response)


_OPENER = build_opener(_RejectRedirects())
_MAX_TOKEN_RESPONSE_BYTES = 64_000


def urlopen(request: Request, *, timeout: float):
    return _OPENER.open(request, timeout=timeout)


class KeycloakTokenExchange:
    """RFC 8693 exchange; the MCP subject token is never used as an API credential."""

    def __init__(
        self,
        *,
        token_endpoint: str,
        client_id: str,
        client_secret: str,
        audience: str,
        verifier: KeycloakJwtVerifier | None = None,
        timeout_seconds: float = 3.0,
        max_cache_entries: int = 256,
    ) -> None:
        self.token_endpoint = _https_url(token_endpoint, "OIDC token endpoint")
        self.client_id = client_id.strip()
        self._client_secret = client_secret
        self.audience = audience.strip()
        if not self.client_id or not self._client_secret or not self.audience:
            raise ValueError("OIDC token exchange client and audience are required")
        if timeout_seconds <= 0 or max_cache_entries <= 0:
            raise ValueError("Token exchange timeout and cache size must be positive")
        self._verifier = verifier
        self._timeout_seconds = timeout_seconds
        self._max_cache_entries = max_cache_entries
        self._cache: OrderedDict[str, tuple[str, float]] = OrderedDict()
        self._lock = Lock()

    def exchange(self, subject_token: AccessToken) -> str:
        cache_key = hashlib.sha256(subject_token.token.encode()).hexdigest()
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(cache_key)
            if cached and now < cached[1]:
                self._cache.move_to_end(cache_key)
                return cached[0]

        form = urlencode(
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                "subject_token": subject_token.token,
                "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "audience": self.audience,
                "scope": " ".join(scope for scope in subject_token.scopes if scope != "mcp:tools"),
            }
        ).encode()
        basic = base64.b64encode(f"{self.client_id}:{self._client_secret}".encode()).decode()
        request = Request(
            self.token_endpoint,
            data=form,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": f"Basic {basic}",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                raw = response.read(_MAX_TOKEN_RESPONSE_BYTES + 1)
        except (HTTPError, URLError, socket.timeout, TimeoutError) as issue:
            raise RuntimeError("OIDC token exchange failed") from issue
        if len(raw) > _MAX_TOKEN_RESPONSE_BYTES:
            raise RuntimeError("OIDC token exchange response exceeded the size limit")
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as issue:
            raise RuntimeError("OIDC token exchange returned invalid JSON") from issue
        token = payload.get("access_token") if isinstance(payload, dict) else None
        token_type = payload.get("token_type", "Bearer") if isinstance(payload, dict) else None
        expires_in = payload.get("expires_in", 60) if isinstance(payload, dict) else None
        if (
            not isinstance(token, str)
            or not token
            or token == subject_token.token
            or not isinstance(token_type, str)
            or token_type.casefold() != "bearer"
            or isinstance(expires_in, bool)
            or not isinstance(expires_in, (int, float))
            or expires_in <= 0
        ):
            raise RuntimeError("OIDC token exchange returned an invalid token")

        if self._verifier is not None:
            verified = self._verifier.verify_token_sync(token)
            tenant = (subject_token.claims or {}).get("tenant_id")
            if (
                verified is None
                or verified.subject != subject_token.subject
                or (verified.claims or {}).get("tenant_id") != tenant
                or not set(verified.scopes).issubset(subject_token.scopes)
            ):
                raise RuntimeError("OIDC token exchange changed the authenticated identity or scopes")

        cache_for = max(1.0, min(float(expires_in) - 30.0, 300.0))
        with self._lock:
            self._cache[cache_key] = (token, time.monotonic() + cache_for)
            self._cache.move_to_end(cache_key)
            while len(self._cache) > self._max_cache_entries:
                self._cache.popitem(last=False)
        return token
