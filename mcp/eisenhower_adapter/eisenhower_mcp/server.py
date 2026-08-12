from __future__ import annotations

import os
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Protocol, TypeVar
from uuid import uuid4

from mcp.server import MCPServer
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.types import ToolAnnotations

from .http_client import EisenhowerApiClient
from .oidc import KeycloakJwtVerifier
from .service import EisenhowerMcpService
from .token_exchange import KeycloakTokenExchange


ResultT = TypeVar("ResultT")


class AuditRecorder(Protocol):
    def record_tool(
        self,
        tool_name: str,
        phase: str,
        outcome: str,
        request_id: str,
        *,
        tenant_id: str | None = None,
        actor_id: str | None = None,
    ) -> None: ...


class _BackendAuditRecorder:
    """Thin MCP adapter over the canonical backend-ai audit storage."""

    def __init__(
        self,
        *,
        path: str,
        hmac_key: bytes,
        release_sha: str,
        tenant_id: str | None = None,
        actor_id: str | None = None,
    ) -> None:
        try:
            from app.audit import AuditAction, AuditEvent, AuditOutcome, SqliteAuditSink
        except ImportError as issue:
            raise RuntimeError(
                "backend-ai app.audit must be importable for MCP audit storage"
            ) from issue
        self._action = AuditAction.MCP_TOOL_USE
        self._event_type = AuditEvent
        self._outcomes = {
            "accepted": AuditOutcome.ATTEMPT,
            "success": AuditOutcome.SUCCESS,
            "error": AuditOutcome.ERROR,
            "rejected": AuditOutcome.REJECTED,
        }
        self._sink = SqliteAuditSink(path, hmac_key=hmac_key)
        self._release_sha = release_sha
        self._tenant_id = tenant_id
        self._actor_id = actor_id

    def record_tool(
        self,
        tool_name: str,
        phase: str,
        outcome: str,
        request_id: str,
        *,
        tenant_id: str | None = None,
        actor_id: str | None = None,
    ) -> None:
        if phase not in {"attempt", "result"} or outcome not in self._outcomes:
            raise ValueError("MCP audit phase or outcome is invalid")
        self._sink.record(
            self._event_type(
                service="mcp-adapter",
                release_sha=self._release_sha,
                event_id=f"mcp-{uuid4().hex}",
                request_id=request_id,
                action=self._action,
                outcome=self._outcomes[outcome],
                tenant_id=tenant_id or self._tenant_id or "unknown-tenant",
                actor_id=actor_id or self._actor_id or "unknown-actor",
                resource_id=f"mcp-tool:{tool_name}:{phase}",
            )
        )


def _audit_recorder_from_environment() -> AuditRecorder:
    names = {
        "path": "EISENHOWER_AUDIT_DB_PATH",
        "key_file": "EISENHOWER_AUDIT_HMAC_KEY_FILE",
        "release_sha": "EISENHOWER_RELEASE_SHA",
        "tenant_id": "EISENHOWER_AUDIT_TENANT_ID",
        "actor_id": "EISENHOWER_AUDIT_ACTOR_ID",
    }
    values = {name: os.environ.get(variable, "").strip() for name, variable in names.items()}
    required = ("path", "key_file", "release_sha")
    missing = [names[name] for name in required if not values[name]]
    if missing:
        raise RuntimeError(f"MCP audit configuration requires {', '.join(missing)}")
    key_file = Path(values["key_file"])
    try:
        if key_file.stat().st_mode & 0o077:
            raise RuntimeError("EISENHOWER_AUDIT_HMAC_KEY_FILE permissions must be 0600")
        hmac_key = key_file.read_bytes()
    except OSError as issue:
        raise RuntimeError("MCP audit key file is unavailable") from issue
    if len(hmac_key) < 32:
        raise RuntimeError("MCP audit key must contain at least 32 bytes")
    return _BackendAuditRecorder(
        path=values["path"],
        hmac_key=hmac_key,
        release_sha=values["release_sha"],
        tenant_id=values["tenant_id"],
        actor_id=values["actor_id"],
    )


_UNSET = object()


def _service_from_environment(*, bearer_token: str | None | object = _UNSET) -> EisenhowerMcpService:
    task_base_url = os.environ.get("EISENHOWER_TASK_API_BASE_URL")
    ai_base_url = os.environ.get("EISENHOWER_AI_API_BASE_URL")
    if not task_base_url or not ai_base_url:
        raise RuntimeError(
            "EISENHOWER_TASK_API_BASE_URL and EISENHOWER_AI_API_BASE_URL are required"
        )
    configured_token = (
        os.environ.get("EISENHOWER_API_TOKEN") if bearer_token is _UNSET else bearer_token
    )
    return EisenhowerMcpService(
        EisenhowerApiClient(
            task_base_url,
            ai_base_url,
            bearer_token=configured_token if isinstance(configured_token, str) else None,
            timeout_seconds=float(os.environ.get("EISENHOWER_API_TIMEOUT_SECONDS", "5")),
        )
    )


service: EisenhowerMcpService | None = None
audit_recorder: AuditRecorder | None = None
token_exchange: KeycloakTokenExchange | None = None
_audit_lock = Lock()
mcp = MCPServer("Eisenhower Matrix")
_READ_TOOL = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
_WRITE_TOOL = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)

_TOOL_SCOPES = {
    "matrix_summary": "tasks:read",
    "tasks_search": "tasks:read",
    "task_get": "tasks:read",
    "project_context": "tasks:read",
    "knowledge_search": "knowledge:read",
    "priority_explain": "tasks:read",
    "task_create": "tasks:write",
    "task_update": "tasks:write",
    "task_lifecycle": "tasks:write",
    "task_schedule": "tasks:write",
    "task_delegation": "tasks:write",
    "calendar_sync_status": "calendar:read",
    "calendar_sync_request": "calendar:write",
    "calendar_conflicts_list": "calendar:read",
    "calendar_conflict_resolve": "calendar:write",
}


def _service() -> EisenhowerMcpService:
    global service
    access_token = get_access_token()
    if access_token is not None:
        if token_exchange is None:
            raise RuntimeError("OIDC token exchange is not configured")
        exchanged_token = token_exchange.exchange(access_token)
        return _service_from_environment(bearer_token=exchanged_token)
    if service is None:
        service = _service_from_environment()
    return service


def _audit() -> AuditRecorder:
    global audit_recorder
    if audit_recorder is None:
        with _audit_lock:
            if audit_recorder is None:
                audit_recorder = _audit_recorder_from_environment()
    return audit_recorder


def _identity(access_token: AccessToken | None) -> tuple[str, str]:
    if access_token is not None:
        tenant_id = (access_token.claims or {}).get("tenant_id")
        if not isinstance(tenant_id, str) or not tenant_id or not access_token.subject:
            raise PermissionError("Authenticated tenant and subject are required")
        return tenant_id, access_token.subject
    tenant_id = os.environ.get("EISENHOWER_AUDIT_TENANT_ID", "").strip()
    actor_id = os.environ.get("EISENHOWER_AUDIT_ACTOR_ID", "").strip()
    if not tenant_id or not actor_id:
        if audit_recorder is not None and not isinstance(audit_recorder, _BackendAuditRecorder):
            return "local-test-tenant", "local-test-actor"
        raise RuntimeError("stdio audit identity requires tenant and actor configuration")
    return tenant_id, actor_id


def _record_tool(
    recorder: AuditRecorder,
    access_token: AccessToken | None,
    tool_name: str,
    phase: str,
    outcome: str,
    request_id: str,
    tenant_id: str,
    actor_id: str,
) -> None:
    if access_token is None:
        recorder.record_tool(tool_name, phase, outcome, request_id)
    else:
        recorder.record_tool(
            tool_name, phase, outcome, request_id,
            tenant_id=tenant_id, actor_id=actor_id,
        )


def _invoke_tool(tool_name: str, operation: Callable[[], ResultT]) -> ResultT:
    request_id = uuid4().hex
    recorder = _audit()
    access_token = get_access_token()
    tenant_id, actor_id = _identity(access_token)
    required_scope = _TOOL_SCOPES[tool_name]
    if access_token is not None and required_scope not in access_token.scopes:
        _record_tool(
            recorder, access_token, tool_name, "result", "rejected", request_id,
            tenant_id, actor_id,
        )
        raise PermissionError(f"Tool requires scope {required_scope}")
    _record_tool(
        recorder, access_token, tool_name, "attempt", "accepted", request_id,
        tenant_id, actor_id,
    )
    try:
        result = operation()
    except Exception:
        _record_tool(
            recorder, access_token, tool_name, "result", "error", request_id,
            tenant_id, actor_id,
        )
        raise
    _record_tool(
        recorder, access_token, tool_name, "result", "success", request_id,
        tenant_id, actor_id,
    )
    return result


@mcp.tool(annotations=_READ_TOOL)
def matrix_summary() -> dict[str, Any]:
    """Summarize task counts in the four canonical Eisenhower quadrants."""
    return _invoke_tool("matrix_summary", lambda: _service().matrix_summary())


@mcp.tool(annotations=_READ_TOOL)
def tasks_search(query: str = "", limit: int = 20) -> dict[str, Any]:
    """Search existing tasks by title or description; never changes tasks."""
    return _invoke_tool("tasks_search", lambda: _service().tasks_search(query, limit))


@mcp.tool(annotations=_READ_TOOL)
def task_get(task_id: str) -> dict[str, Any]:
    """Return one existing task by identifier using the public tasks API."""
    return _invoke_tool("task_get", lambda: _service().task_get(task_id))


@mcp.tool(annotations=_READ_TOOL)
def project_context(project_id: str, limit: int = 100) -> dict[str, Any]:
    """Return task context associated with a project identifier."""
    return _invoke_tool("project_context", lambda: _service().project_context(project_id, limit))


@mcp.tool(annotations=_READ_TOOL)
def knowledge_search(query: str, project_id: str | None = None, limit: int = 5) -> dict[str, Any]:
    """Search indexed project knowledge and preserve source citations."""
    return _invoke_tool(
        "knowledge_search",
        lambda: _service().knowledge_search(query, project_id, limit),
    )


@mcp.tool(annotations=_READ_TOOL)
def priority_explain(task_id: str) -> dict[str, Any]:
    """Explain a task's priority using deterministic Eisenhower rules."""
    return _invoke_tool("priority_explain", lambda: _service().priority_explain(task_id))


@mcp.tool(annotations=_WRITE_TOOL)
def task_create(
    title: str,
    idempotency_key: str,
    description: str = "",
    urgent: bool = False,
    important: bool = False,
) -> dict[str, Any]:
    """Create one task through the fixed task API; requires a retry-safe operation key."""
    return _invoke_tool(
        "task_create",
        lambda: _service().task_create(title, idempotency_key, description, urgent, important),
    )


@mcp.tool(annotations=_WRITE_TOOL)
def task_update(
    task_id: str,
    expected_revision: int,
    idempotency_key: str,
    title: str | None = None,
    description: str | None = None,
    urgent: bool | None = None,
    important: bool | None = None,
) -> dict[str, Any]:
    """Update selected task fields with optimistic concurrency; never deletes a task."""
    return _invoke_tool(
        "task_update",
        lambda: _service().task_update(
            task_id,
            expected_revision,
            idempotency_key,
            title,
            description,
            urgent,
            important,
        ),
    )


@mcp.tool(annotations=_WRITE_TOOL)
def task_lifecycle(
    task_id: str,
    expected_revision: int,
    action: str,
    idempotency_key: str,
) -> dict[str, Any]:
    """Apply one reversible lifecycle action with an expected task revision."""
    return _invoke_tool(
        "task_lifecycle",
        lambda: _service().task_lifecycle(task_id, expected_revision, action, idempotency_key),
    )


@mcp.tool(annotations=_WRITE_TOOL)
def task_schedule(
    task_id: str,
    expected_revision: int,
    idempotency_key: str,
    due_at: str | None = None,
    time_zone: str | None = None,
    remind_at: str | None = None,
    clear: bool = False,
) -> dict[str, Any]:
    """Set or explicitly clear one task schedule with optimistic concurrency."""
    return _invoke_tool(
        "task_schedule",
        lambda: _service().task_schedule(
            task_id,
            expected_revision,
            idempotency_key,
            due_at,
            time_zone,
            remind_at,
            clear,
        ),
    )


@mcp.tool(annotations=_WRITE_TOOL)
def task_delegation(
    task_id: str,
    expected_revision: int,
    idempotency_key: str,
    assignee_user_id: str | None = None,
    display_label: str | None = None,
    handoff_note: str = "",
    status: str | None = None,
    clear: bool = False,
) -> dict[str, Any]:
    """Assign, transition, or explicitly clear delegation using one fixed mode."""
    return _invoke_tool(
        "task_delegation",
        lambda: _service().task_delegation(
            task_id,
            expected_revision,
            idempotency_key,
            assignee_user_id,
            display_label,
            handoff_note,
            status,
            clear,
        ),
    )


@mcp.tool(annotations=_READ_TOOL)
def calendar_sync_status() -> dict[str, Any]:
    """Return calendar sync status once the public HTTP contract is available."""
    return _invoke_tool("calendar_sync_status", lambda: _service().calendar_sync_status())


@mcp.tool(annotations=_WRITE_TOOL)
def calendar_sync_request(idempotency_key: str) -> dict[str, Any]:
    """Request calendar synchronization once the public HTTP contract is available."""
    return _invoke_tool(
        "calendar_sync_request",
        lambda: _service().calendar_sync_request(idempotency_key),
    )


@mcp.tool(annotations=_READ_TOOL)
def calendar_conflicts_list() -> dict[str, Any]:
    """List open calendar conflicts visible to the authenticated owner."""
    return _invoke_tool(
        "calendar_conflicts_list", lambda: _service().calendar_conflicts_list()
    )


@mcp.tool(annotations=_WRITE_TOOL)
def calendar_conflict_resolve(
    conflict_id: str,
    expected_revision: int,
    strategy: str,
    idempotency_key: str,
) -> dict[str, Any]:
    """Resolve one calendar conflict using a fixed strategy and expected revision."""
    return _invoke_tool(
        "calendar_conflict_resolve",
        lambda: _service().calendar_conflict_resolve(
            conflict_id, expected_revision, strategy, idempotency_key
        ),
    )


def _required_environment(names: list[str]) -> dict[str, str]:
    values = {name: os.environ.get(name, "").strip() for name in names}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise RuntimeError(f"Remote MCP OIDC configuration requires {', '.join(missing)}")
    return values


def _remote_server_from_environment() -> MCPServer:
    global token_exchange
    names = [
        "MCP_OIDC_ISSUER",
        "MCP_OIDC_AUDIENCE",
        "MCP_OIDC_JWKS_URL",
        "MCP_RESOURCE_SERVER_URL",
        "MCP_OIDC_TOKEN_ENDPOINT",
        "MCP_OIDC_CLIENT_ID",
        "MCP_OIDC_CLIENT_SECRET",
        "EISENHOWER_API_AUDIENCE",
    ]
    values = _required_environment(names)
    timeout = float(os.environ.get("MCP_OIDC_TIMEOUT_SECONDS", "3"))
    cache_ttl = float(os.environ.get("MCP_OIDC_JWKS_CACHE_SECONDS", "300"))
    tenant_claim = os.environ.get("MCP_OIDC_TENANT_CLAIM", "tenant_id")
    verifier = KeycloakJwtVerifier(
        issuer=values["MCP_OIDC_ISSUER"],
        audience=values["MCP_OIDC_AUDIENCE"],
        jwks_url=values["MCP_OIDC_JWKS_URL"],
        timeout_seconds=timeout,
        cache_ttl_seconds=cache_ttl,
        tenant_claim=tenant_claim,
    )
    upstream_verifier = KeycloakJwtVerifier(
        issuer=values["MCP_OIDC_ISSUER"],
        audience=values["EISENHOWER_API_AUDIENCE"],
        jwks_url=values["MCP_OIDC_JWKS_URL"],
        timeout_seconds=timeout,
        cache_ttl_seconds=cache_ttl,
        tenant_claim=tenant_claim,
    )
    token_exchange = KeycloakTokenExchange(
        token_endpoint=values["MCP_OIDC_TOKEN_ENDPOINT"],
        client_id=values["MCP_OIDC_CLIENT_ID"],
        client_secret=values["MCP_OIDC_CLIENT_SECRET"],
        audience=values["EISENHOWER_API_AUDIENCE"],
        verifier=upstream_verifier,
        timeout_seconds=timeout,
    )
    tools = mcp._tool_manager.list_tools()
    for tool in tools:
        tool.meta = {
            **(tool.meta or {}),
            "io.modelcontextprotocol/authorization": {
                "requiredScopes": [_TOOL_SCOPES[tool.name]],
            },
        }
    return MCPServer(
        "Eisenhower Matrix",
        tools=tools,
        token_verifier=verifier,
        auth=AuthSettings(
            issuer_url=values["MCP_OIDC_ISSUER"],
            resource_server_url=values["MCP_RESOURCE_SERVER_URL"],
            required_scopes=["mcp:tools"],
        ),
    )


def main() -> None:
    transport = os.environ.get("MCP_TRANSPORT", "stdio")
    if transport == "stdio":
        mcp.run(transport="stdio")
        return
    if transport != "streamable-http":
        raise ValueError("MCP_TRANSPORT must be stdio or streamable-http")

    host = os.environ.get("MCP_HOST", "127.0.0.1")
    behind_proxy = os.environ.get("MCP_BEHIND_TRUSTED_PROXY", "false").casefold() == "true"
    if host not in {"127.0.0.1", "::1", "localhost"} and not (
        host == "0.0.0.0" and behind_proxy
    ):
        raise ValueError("Streamable HTTP must bind to loopback behind an authenticated gateway")

    remote_mcp = _remote_server_from_environment()
    remote_mcp.run(
        transport="streamable-http",
        json_response=True,
        host=host,
        port=int(os.environ.get("MCP_PORT", "8000")),
        streamable_http_path=os.environ.get("MCP_HTTP_PATH", "/mcp"),
        max_request_body_size=int(os.environ.get("MCP_MAX_REQUEST_BODY_BYTES", "1048576")),
    )


if __name__ == "__main__":
    main()
