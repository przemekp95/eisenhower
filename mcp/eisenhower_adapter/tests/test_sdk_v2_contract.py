import asyncio
import os
import unittest
from unittest.mock import patch

from mcp.client import Client

from eisenhower_mcp import server


class _ReadOnlyService:
    def matrix_summary(self):
        return {"quadrants": {}}


class McpSdkV2ContractTest(unittest.TestCase):
    def test_streamable_http_rejects_non_loopback_bind_without_an_auth_layer(self) -> None:
        with patch.dict(
            os.environ,
            {"MCP_TRANSPORT": "streamable-http", "MCP_HOST": "0.0.0.0"},
            clear=False,
        ):
            with self.assertRaisesRegex(ValueError, "loopback"):
                server.main()

    def test_official_client_lists_exactly_the_read_only_tools(self) -> None:
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
                },
            )
            self.assertTrue(all(tool.input_schema["type"] == "object" for tool in result.tools))
            self.assertTrue(all(tool.output_schema["type"] == "object" for tool in result.tools))

        asyncio.run(verify())

    def test_official_client_receives_structured_read_only_result(self) -> None:
        async def verify() -> None:
            original = server.service
            server.service = _ReadOnlyService()
            try:
                async with Client(server.mcp) as client:
                    result = await client.call_tool("matrix_summary", {})
            finally:
                server.service = original

            self.assertFalse(result.is_error)
            self.assertIn('"quadrants"', result.content[0].text)

        asyncio.run(verify())


if __name__ == "__main__":
    unittest.main()
