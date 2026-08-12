import ast
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from eisenhower_mcp import server


class ServerContractTest(unittest.TestCase):
    def test_environment_configuration_fails_closed_without_both_upstreams(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "TASK_API_BASE_URL.*AI_API_BASE_URL"):
                server._service_from_environment()

    def test_environment_configuration_preserves_split_task_and_ai_topology(self) -> None:
        with patch.dict(
            os.environ,
            {
                "EISENHOWER_TASK_API_BASE_URL": "http://127.0.0.1:3001",
                "EISENHOWER_AI_API_BASE_URL": "http://127.0.0.1:8000",
            },
            clear=True,
        ):
            configured = server._service_from_environment()

        self.assertEqual(configured._api.task_base_url, "http://127.0.0.1:3001")
        self.assertEqual(configured._api.ai_base_url, "http://127.0.0.1:8000")

    def test_uses_current_mcp_v2_server_and_a_validated_entrypoint(self) -> None:
        root = Path(__file__).parents[1]
        source = root.joinpath("eisenhower_mcp", "server.py").read_text(encoding="utf-8")
        project = root.joinpath("pyproject.toml").read_text(encoding="utf-8")

        self.assertIn("from mcp.server import MCPServer", source)
        self.assertIn('mcp = MCPServer("Eisenhower Matrix")', source)
        self.assertNotIn("FastMCP", source)
        self.assertIn("def main()", source)
        self.assertIn('eisenhower-mcp = "eisenhower_mcp.server:main"', project)
        self.assertIn('dependencies = ["mcp==2.0.0"]', project)

    def test_registers_exactly_six_read_only_tools(self) -> None:
        source = Path(__file__).parents[1].joinpath("eisenhower_mcp", "server.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        registered: list[str] = []

        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if any(
                isinstance(decorator, ast.Call)
                and isinstance(decorator.func, ast.Attribute)
                and decorator.func.attr == "tool"
                for decorator in node.decorator_list
            ):
                registered.append(node.name)

        self.assertEqual(
            sorted(registered),
            sorted(
                [
                    "matrix_summary",
                    "tasks_search",
                    "task_get",
                    "project_context",
                    "knowledge_search",
                    "priority_explain",
                ]
            ),
        )
        self.assertNotIn("workflow_execute", source)
        self.assertNotIn("task_create", source)
        self.assertNotIn("task_update", source)
        self.assertNotIn("task_delete", source)


if __name__ == "__main__":
    unittest.main()
