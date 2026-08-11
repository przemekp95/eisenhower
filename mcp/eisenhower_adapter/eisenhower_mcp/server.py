from __future__ import annotations

import os
from typing import Any

from mcp.server import MCPServer

from .http_client import EisenhowerApiClient
from .service import EisenhowerMcpService


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
mcp = MCPServer("Eisenhower Matrix")


def _service() -> EisenhowerMcpService:
    global service
    if service is None:
        service = _service_from_environment()
    return service


@mcp.tool()
def matrix_summary() -> dict[str, Any]:
    """Summarize task counts in the four canonical Eisenhower quadrants."""
    return _service().matrix_summary()


@mcp.tool()
def tasks_search(query: str = "", limit: int = 20) -> dict[str, Any]:
    """Search existing tasks by title or description; never changes tasks."""
    return _service().tasks_search(query, limit)


@mcp.tool()
def task_get(task_id: str) -> dict[str, Any]:
    """Return one existing task by identifier using the public tasks API."""
    return _service().task_get(task_id)


@mcp.tool()
def project_context(project_id: str, limit: int = 100) -> dict[str, Any]:
    """Return task context associated with a project identifier."""
    return _service().project_context(project_id, limit)


@mcp.tool()
def knowledge_search(query: str, project_id: str | None = None, limit: int = 5) -> dict[str, Any]:
    """Search indexed project knowledge and preserve source citations."""
    return _service().knowledge_search(query, project_id, limit)


@mcp.tool()
def priority_explain(task_id: str) -> dict[str, Any]:
    """Explain a task's priority using deterministic Eisenhower rules."""
    return _service().priority_explain(task_id)


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
