import asyncio
import os
import unittest
from unittest.mock import patch

from mcp.client import Client

from eisenhower_mcp import server


class _ReadOnlyService:
    def __init__(self):
        self.calls = 0

    def matrix_summary(self):
        self.calls += 1
        return {"quadrants": {}}


class _FailingService:
    def matrix_summary(self):
        raise RuntimeError("upstream unavailable")


class _AuditRecorder:
    def __init__(self, *, fail: bool = False):
        self.events = []
        self.fail = fail

    def record_tool(self, tool_name, phase, outcome, request_id):
        if self.fail:
            raise RuntimeError("audit unavailable")
        self.events.append((tool_name, phase, outcome, request_id))


class McpSdkV2ContractTest(unittest.TestCase):
    def test_streamable_http_rejects_non_loopback_bind_without_an_auth_layer(self) -> None:
        with patch.dict(
            os.environ,
            {"MCP_TRANSPORT": "streamable-http", "MCP_HOST": "0.0.0.0"},
            clear=False,
        ):
            with self.assertRaisesRegex(ValueError, "loopback"):
                server.main()

    def test_official_client_lists_exactly_the_bounded_tools(self) -> None:
        async def verify() -> None:
            async with Client(server.mcp) as client:
                result = await client.list_tools()

            self.assertEqual(
                {tool.name for tool in result.tools},
                {
                    "matrix_summary",
                    "tasks_search",
                    "task_get",
                    "project_context",
                    "knowledge_search",
                    "priority_explain",
                    "task_create",
                    "task_update",
                    "task_lifecycle",
                    "task_schedule",
                    "task_delegation",
                    "calendar_sync_status",
                    "calendar_sync_request",
                    "calendar_conflicts_list",
                    "calendar_conflict_resolve",
                },
            )
            self.assertTrue(all(tool.input_schema["type"] == "object" for tool in result.tools))
            self.assertTrue(all(tool.output_schema["type"] == "object" for tool in result.tools))

        asyncio.run(verify())

    def test_official_client_receives_structured_read_only_result(self) -> None:
        async def verify() -> None:
            original = server.service
            original_audit = server.audit_recorder
            server.service = _ReadOnlyService()
            server.audit_recorder = _AuditRecorder()
            try:
                async with Client(server.mcp) as client:
                    result = await client.call_tool("matrix_summary", {})
            finally:
                server.service = original
                server.audit_recorder = original_audit

            self.assertFalse(result.is_error)
            self.assertIn('"quadrants"', result.content[0].text)

        asyncio.run(verify())

    def test_tool_records_attempt_and_result_without_arguments_or_content(self) -> None:
        async def verify() -> None:
            original = server.service
            original_audit = server.audit_recorder
            recorder = _AuditRecorder()
            server.service = _ReadOnlyService()
            server.audit_recorder = recorder
            try:
                async with Client(server.mcp) as client:
                    result = await client.call_tool("matrix_summary", {})
            finally:
                server.service = original
                server.audit_recorder = original_audit

            self.assertFalse(result.is_error)
            self.assertEqual(
                [(tool, phase, outcome) for tool, phase, outcome, _request_id in recorder.events],
                [
                    ("matrix_summary", "attempt", "accepted"),
                    ("matrix_summary", "result", "success"),
                ],
            )
            self.assertEqual(len({event[3] for event in recorder.events}), 1)
            self.assertNotIn("quadrants", repr(recorder.events))

        asyncio.run(verify())

    def test_tool_failure_is_audited_without_exposing_failure_content(self) -> None:
        async def verify() -> None:
            original = server.service
            original_audit = server.audit_recorder
            recorder = _AuditRecorder()
            server.service = _FailingService()
            server.audit_recorder = recorder
            try:
                async with Client(server.mcp) as client:
                    result = await client.call_tool("matrix_summary", {})
            finally:
                server.service = original
                server.audit_recorder = original_audit

            self.assertTrue(result.is_error)
            self.assertEqual(
                [(tool, phase, outcome) for tool, phase, outcome, _request_id in recorder.events],
                [
                    ("matrix_summary", "attempt", "accepted"),
                    ("matrix_summary", "result", "error"),
                ],
            )
            self.assertNotIn("upstream unavailable", repr(recorder.events))

        asyncio.run(verify())

    def test_audit_unavailable_fails_closed_before_calling_tool_service(self) -> None:
        async def verify() -> None:
            original = server.service
            original_audit = server.audit_recorder
            service = _ReadOnlyService()
            server.service = service
            server.audit_recorder = _AuditRecorder(fail=True)
            try:
                async with Client(server.mcp) as client:
                    result = await client.call_tool("matrix_summary", {})
            finally:
                server.service = original
                server.audit_recorder = original_audit

            self.assertTrue(result.is_error)
            self.assertEqual(service.calls, 0)

        asyncio.run(verify())


if __name__ == "__main__":
    unittest.main()
