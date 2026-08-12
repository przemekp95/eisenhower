from __future__ import annotations

import os
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Protocol, TypeVar
from uuid import uuid4

from mcp.server import MCPServer
from mcp.types import ToolAnnotations

from .http_client import EisenhowerApiClient
from .service import EisenhowerMcpService


ResultT = TypeVar("ResultT")


class AuditRecorder(Protocol):
    def record_tool(self, tool_name: str, phase: str, outcome: str, request_id: str) -> None: ...


class _BackendAuditRecorder:
    """Thin MCP adapter over the canonical backend-ai audit storage."""

    def __init__(
        self,
        *,
        path: str,
        hmac_key: bytes,
        release_sha: str,
        tenant_id: str,
        actor_id: str,
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
        }
        self._sink = SqliteAuditSink(path, hmac_key=hmac_key)
        self._release_sha = release_sha
        self._tenant_id = tenant_id
        self._actor_id = actor_id

    def record_tool(self, tool_name: str, phase: str, outcome: str, request_id: str) -> None:
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
                tenant_id=self._tenant_id,
                actor_id=self._actor_id,
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
    missing = [names[name] for name, value in values.items() if not value]
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


def _service_from_environment() -> EisenhowerMcpService:
    task_base_url = os.environ.get("EISENHOWER_TASK_API_BASE_URL")
    ai_base_url = os.environ.get("EISENHOWER_AI_API_BASE_URL")
    if not task_base_url or not ai_base_url:
        raise RuntimeError(
            "EISENHOWER_TASK_API_BASE_URL and EISENHOWER_AI_API_BASE_URL are required"
        )
    return EisenhowerMcpService(
        EisenhowerApiClient(
            task_base_url,
            ai_base_url,
            bearer_token=os.environ.get("EISENHOWER_API_TOKEN"),
            timeout_seconds=float(os.environ.get("EISENHOWER_API_TIMEOUT_SECONDS", "5")),
        )
    )


service: EisenhowerMcpService | None = None
audit_recorder: AuditRecorder | None = None
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


def _service() -> EisenhowerMcpService:
    global service
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


def _invoke_tool(tool_name: str, operation: Callable[[], ResultT]) -> ResultT:
    request_id = uuid4().hex
    recorder = _audit()
    recorder.record_tool(tool_name, "attempt", "accepted", request_id)
    try:
        result = operation()
    except Exception:
        recorder.record_tool(tool_name, "result", "error", request_id)
        raise
    recorder.record_tool(tool_name, "result", "success", request_id)
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


def main() -> None:
    transport = os.environ.get("MCP_TRANSPORT", "stdio")
    if transport == "stdio":
        mcp.run(transport="stdio")
        return
    if transport != "streamable-http":
        raise ValueError("MCP_TRANSPORT must be stdio or streamable-http")

    host = os.environ.get("MCP_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "::1", "localhost"}:
        raise ValueError("Streamable HTTP must bind to loopback behind an authenticated gateway")

    mcp.run(
        transport="streamable-http",
        json_response=True,
        host=host,
        port=int(os.environ.get("MCP_PORT", "8000")),
        streamable_http_path=os.environ.get("MCP_HTTP_PATH", "/mcp"),
        max_request_body_size=int(os.environ.get("MCP_MAX_REQUEST_BODY_BYTES", "1048576")),
    )


if __name__ == "__main__":
    main()
