import asyncio
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
from threading import Event, Thread
import time
import unittest

from mcp.client import Client

from eisenhower_mcp import server
from eisenhower_mcp.http_client import EisenhowerApiClient
from eisenhower_mcp.service import EisenhowerMcpService


READ_TOKEN = "integration-read-token"
PRIVATE_ERROR_DETAIL = "private-upstream-debug-detail"


@dataclass
class _AuditRecorder:
    events: list[tuple[str, str, str, str]] = field(default_factory=list)

    def record_tool(self, tool_name: str, phase: str, outcome: str, request_id: str) -> None:
        self.events.append((tool_name, phase, outcome, request_id))


@dataclass
class _UpstreamState:
    service: str
    requests: list[dict[str, object]] = field(default_factory=list)
    timeout_completed: Event = field(default_factory=Event)


class _HermeticHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False


def _handler(state: _UpstreamState):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - standard-library handler contract
            self._dispatch()

        def do_POST(self) -> None:  # noqa: N802 - standard-library handler contract
            self._dispatch()

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def _dispatch(self) -> None:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_length) if content_length else b""
            body = json.loads(raw_body) if raw_body else None
            request = {
                "method": self.command,
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "body": body,
            }
            state.requests.append(request)

            authorization = self.headers.get("Authorization")
            if authorization is None:
                self._send_json(401, {"error": PRIVATE_ERROR_DETAIL})
                return
            if authorization != f"Bearer {READ_TOKEN}":
                self._send_json(403, {"error": PRIVATE_ERROR_DETAIL})
                return

            if state.service == "tasks" and self.command == "GET" and self.path == "/tasks":
                self._send_json(
                    200,
                    [
                        {
                            "_id": "task-1",
                            "title": "Prepare roadmap",
                            "description": "Project alpha",
                            "urgent": False,
                            "important": True,
                            "projectId": "alpha",
                        },
                        {
                            "_id": "task-2",
                            "title": "Delegate status report",
                            "description": "Weekly report",
                            "urgent": True,
                            "important": False,
                        },
                    ],
                )
                return

            if (
                state.service == "ai"
                and self.command == "POST"
                and self.path == "/v2/knowledge/search"
            ):
                if body and body.get("query") == "force timeout":
                    try:
                        time.sleep(0.15)
                        self._send_json(200, {"citations": []})
                    finally:
                        state.timeout_completed.set()
                    return
                self._send_json(
                    200,
                    {
                        "query": body["query"],
                        "answer": None,
                        "citations": [
                            {
                                "chunk_id": "chunk-1",
                                "document_id": "doc-1",
                                "source_uri": "eisenhower://repository/runbook.md",
                                "title": "Runbook",
                                "excerpt": "Use governed retrieval.",
                                "score": 0.91,
                                "content_version": "eisenhower-corpus-v1:abc",
                            }
                        ],
                        "retrieval": {
                            "hit_count": 1,
                            "top_score": 0.91,
                            "embedding_version": "minilm-v1",
                        },
                    },
                )
                return

            self._send_json(404, {"error": PRIVATE_ERROR_DETAIL})

        def _send_json(self, status: int, payload: object) -> None:
            encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                # A timeout test deliberately closes the client side first.
                return

    return Handler


class _RunningUpstream:
    def __init__(self, service: str):
        self.state = _UpstreamState(service)
        self.httpd = _HermeticHttpServer(("127.0.0.1", 0), _handler(self.state))
        self.thread = Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address
        return f"http://{host}:{port}"

    @property
    def address(self) -> tuple[str, int]:
        host, port = self.httpd.server_address
        return str(host), int(port)

    def __enter__(self) -> "_RunningUpstream":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)


def _json_result(result) -> dict:
    if result.is_error:
        raise AssertionError(f"unexpected MCP error: {result.content}")
    return json.loads(result.content[0].text)


def _error_text(result) -> str:
    if not result.is_error:
        raise AssertionError("expected an MCP tool error")
    return " ".join(getattr(item, "text", "") for item in result.content)


class McpRealHttpIntegrationTest(unittest.TestCase):
    def test_all_read_only_tools_and_sanitized_upstream_failures(self) -> None:
        task_upstream = _RunningUpstream("tasks")
        ai_upstream = _RunningUpstream("ai")
        task_address = task_upstream.address
        ai_address = ai_upstream.address
        original_service = server.service
        original_audit = server.audit_recorder
        recorder = _AuditRecorder()

        try:
            with task_upstream, ai_upstream:
                server.audit_recorder = recorder
                server.service = EisenhowerMcpService(
                    EisenhowerApiClient(
                        task_upstream.url,
                        ai_upstream.url,
                        bearer_token=READ_TOKEN,
                        timeout_seconds=1.0,
                    )
                )
                results = asyncio.run(self._call_every_tool())

                self.assertEqual(results["matrix_summary"]["total"], 2)
                self.assertEqual(results["matrix_summary"]["quadrants"]["1"]["count"], 1)
                self.assertEqual(results["matrix_summary"]["quadrants"]["2"]["count"], 1)
                self.assertEqual(results["tasks_search"]["tasks"][0]["id"], "task-1")
                self.assertEqual(results["task_get"]["task"]["id"], "task-2")
                self.assertEqual(results["project_context"]["tasks"][0]["project_id"], "alpha")
                self.assertEqual(results["priority_explain"]["quadrant_label"], "Delegate")
                self.assertEqual(
                    results["knowledge_search"]["citations"][0]["content_version"],
                    "eisenhower-corpus-v1:abc",
                )

                successful_task_requests = [
                    request
                    for request in task_upstream.state.requests
                    if request["authorization"] == f"Bearer {READ_TOKEN}"
                ]
                self.assertEqual(len(successful_task_requests), 5)
                self.assertTrue(
                    all(
                        request["method"] == "GET" and request["path"] == "/tasks"
                        for request in successful_task_requests
                    )
                )
                successful_ai_requests = [
                    request
                    for request in ai_upstream.state.requests
                    if request["authorization"] == f"Bearer {READ_TOKEN}"
                    and request["body"]["query"] != "force timeout"
                ]
                self.assertEqual(
                    successful_ai_requests,
                    [
                        {
                            "method": "POST",
                            "path": "/v2/knowledge/search",
                            "authorization": f"Bearer {READ_TOKEN}",
                            "body": {
                                "query": "governed retrieval",
                                "project_id": "alpha",
                                "limit": 3,
                            },
                        }
                    ],
                )

                unauthorized = asyncio.run(
                    self._call_with_service(
                        EisenhowerMcpService(
                            EisenhowerApiClient(task_upstream.url, ai_upstream.url)
                        ),
                        "matrix_summary",
                        {},
                    )
                )
                forbidden = asyncio.run(
                    self._call_with_service(
                        EisenhowerMcpService(
                            EisenhowerApiClient(
                                task_upstream.url,
                                ai_upstream.url,
                                bearer_token="wrong-token",
                            )
                        ),
                        "matrix_summary",
                        {},
                    )
                )
                timed_out = asyncio.run(
                    self._call_with_service(
                        EisenhowerMcpService(
                            EisenhowerApiClient(
                                task_upstream.url,
                                ai_upstream.url,
                                bearer_token=READ_TOKEN,
                                timeout_seconds=0.02,
                            )
                        ),
                        "knowledge_search",
                        {"query": "force timeout"},
                    )
                )

                self.assertIn("HTTP 401", _error_text(unauthorized))
                self.assertIn("HTTP 403", _error_text(forbidden))
                self.assertIn("unavailable", _error_text(timed_out))
                for failure in (unauthorized, forbidden, timed_out):
                    failure_text = _error_text(failure)
                    self.assertNotIn(PRIVATE_ERROR_DETAIL, failure_text)
                    self.assertNotIn(READ_TOKEN, failure_text)
                    self.assertNotIn("wrong-token", failure_text)
                self.assertTrue(ai_upstream.state.timeout_completed.wait(timeout=1))
        finally:
            server.service = original_service
            server.audit_recorder = original_audit

        self.assertEqual(len(recorder.events), 18)
        self.assertEqual(
            [outcome for _tool, _phase, outcome, _request_id in recorder.events].count("error"),
            3,
        )
        self.assertEqual(len({event[3] for event in recorder.events}), 9)
        self.assertNotIn(PRIVATE_ERROR_DETAIL, repr(recorder.events))
        self.assertNotIn(READ_TOKEN, repr(recorder.events))

        self.assertFalse(task_upstream.thread.is_alive())
        self.assertFalse(ai_upstream.thread.is_alive())
        for address in (task_address, ai_address):
            probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            probe.settimeout(0.1)
            try:
                with self.assertRaises(OSError):
                    probe.connect(address)
            finally:
                probe.close()

    @staticmethod
    async def _call_every_tool() -> dict[str, dict]:
        calls = {
            "matrix_summary": {},
            "tasks_search": {"query": "roadmap", "limit": 1},
            "task_get": {"task_id": "task-2"},
            "project_context": {"project_id": "alpha", "limit": 10},
            "knowledge_search": {"query": "governed retrieval", "project_id": "alpha", "limit": 3},
            "priority_explain": {"task_id": "task-2"},
        }
        async with Client(server.mcp) as client:
            return {
                name: _json_result(await client.call_tool(name, arguments))
                for name, arguments in calls.items()
            }

    @staticmethod
    async def _call_with_service(service, tool: str, arguments: dict):
        previous = server.service
        server.service = service
        try:
            async with Client(server.mcp) as client:
                return await client.call_tool(tool, arguments)
        finally:
            server.service = previous


if __name__ == "__main__":
    unittest.main()
