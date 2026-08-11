from __future__ import annotations

import json
import socket
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


class ApiClientError(RuntimeError):
    """A sanitized upstream API failure suitable for an MCP tool error."""


class EisenhowerApiClient:
    def __init__(
        self,
        task_base_url: str,
        ai_base_url: str,
        *,
        bearer_token: str | None = None,
        timeout_seconds: float = 5.0,
        max_response_bytes: int = 1_000_000,
    ) -> None:
        self.task_base_url = self._validate_base_url(task_base_url, "task")
        self.ai_base_url = self._validate_base_url(ai_base_url, "AI")
        if timeout_seconds <= 0 or max_response_bytes <= 0:
            raise ValueError("Timeout and response size limit must be positive")

        self._bearer_token = bearer_token
        self._timeout_seconds = timeout_seconds
        self._max_response_bytes = max_response_bytes

    @staticmethod
    def _validate_base_url(base_url: str, service_name: str) -> str:
        normalized = base_url.rstrip("/") + "/"
        parsed = urlparse(normalized)
        is_loopback = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        if parsed.scheme != "https" and not (parsed.scheme == "http" and is_loopback):
            raise ValueError(f"Remote Eisenhower {service_name} API URLs must use HTTPS")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("The API base URL must not contain credentials, query parameters, or fragments")
        return normalized.rstrip("/")

    def list_tasks(self) -> list[dict[str, Any]]:
        payload = self._request(self.task_base_url, "GET", "tasks")
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise ApiClientError("The tasks API returned an invalid response")
        return payload

    def search_knowledge(self, query: str, project_id: str | None, limit: int) -> dict[str, Any]:
        payload = self._request(
            self.ai_base_url,
            "POST",
            "v2/knowledge/search",
            {
                "query": query,
                "project_id": project_id,
                "limit": limit,
            },
        )
        if not isinstance(payload, dict) or not isinstance(payload.get("citations", []), list):
            raise ApiClientError("The knowledge API returned an invalid response")
        return payload

    def _request(
        self,
        base_url: str,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> Any:
        url = urljoin(base_url + "/", path.lstrip("/"))
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self._bearer_token:
            headers["Authorization"] = f"Bearer {self._bearer_token}"

        request = Request(url, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                raw = response.read(self._max_response_bytes + 1)
                if len(raw) > self._max_response_bytes:
                    raise ApiClientError("The Eisenhower API response exceeded the configured size limit")
                if not raw:
                    return None
                return json.loads(raw)
        except HTTPError as error:
            try:
                error.close()
            finally:
                raise ApiClientError(f"The Eisenhower API returned HTTP {error.code}") from error
        except (URLError, socket.timeout, TimeoutError) as error:
            raise ApiClientError("The Eisenhower API is unavailable") from error
        except json.JSONDecodeError as error:
            raise ApiClientError("The Eisenhower API returned invalid JSON") from error
