import ast
import os
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from eisenhower_mcp import server


class ServerContractTest(unittest.TestCase):
    def test_container_packages_canonical_audit_without_fastapi_package_side_effects(self) -> None:
        root = Path(__file__).resolve().parents[3]
        dockerfile = (root / "mcp" / "eisenhower_adapter" / "Dockerfile").read_text()
        self.assertIn("backend-ai/app/audit.py /app/backend-ai/app/audit.py", dockerfile)
        self.assertIn("mcp/eisenhower_adapter/audit_runtime/__init__.py", dockerfile)
        self.assertNotIn("COPY backend-ai/app/__init__.py", dockerfile)

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

    def test_audit_environment_fails_closed_when_durable_sink_configuration_is_missing(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "AUDIT_DB_PATH.*AUDIT_HMAC_KEY_FILE"):
                server._audit_recorder_from_environment()

    def test_audit_environment_uses_shared_backend_sink_without_copying_storage(self) -> None:
        key_file = Path(self.id().replace(".", "-"))
        key_file.write_bytes(b"mcp-audit-test-key-at-least-32-bytes")
        key_file.chmod(0o600)
        factory = Mock(return_value=object())
        try:
            with patch.dict(
                os.environ,
                {
                    "EISENHOWER_AUDIT_DB_PATH": "/private/audit.sqlite3",
                    "EISENHOWER_AUDIT_HMAC_KEY_FILE": str(key_file),
                    "EISENHOWER_RELEASE_SHA": "a" * 40,
                    "EISENHOWER_AUDIT_TENANT_ID": "tenant-a",
                    "EISENHOWER_AUDIT_ACTOR_ID": "actor-a",
                },
                clear=True,
            ), patch.object(server, "_BackendAuditRecorder", factory):
                configured = server._audit_recorder_from_environment()
        finally:
            key_file.unlink(missing_ok=True)

        self.assertIs(configured, factory.return_value)
        factory.assert_called_once_with(
            path="/private/audit.sqlite3",
            hmac_key=b"mcp-audit-test-key-at-least-32-bytes",
            release_sha="a" * 40,
            tenant_id="tenant-a",
            actor_id="actor-a",
        )

    def test_uses_current_mcp_v2_server_and_a_validated_entrypoint(self) -> None:
        root = Path(__file__).parents[1]
        source = root.joinpath("eisenhower_mcp", "server.py").read_text(encoding="utf-8")
        project = root.joinpath("pyproject.toml").read_text(encoding="utf-8")

        self.assertIn("from mcp.server import MCPServer", source)
        self.assertIn('mcp = MCPServer("Eisenhower Matrix")', source)
        self.assertNotIn("FastMCP", source)
        self.assertIn("def main()", source)
        self.assertIn('eisenhower-mcp = "eisenhower_mcp.server:main"', project)
        self.assertIn('"mcp==2.0.0"', project)
        self.assertIn('"PyJWT[crypto]>=2.10,<3"', project)

    def test_registers_exactly_the_bounded_read_and_write_tools(self) -> None:
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
                    "task_create",
                    "task_update",
                    "task_lifecycle",
                    "task_schedule",
                    "task_delegation",
                    "calendar_sync_status",
                    "calendar_sync_request",
                    "calendar_conflicts_list",
                    "calendar_conflict_resolve",
                ]
            ),
        )
        self.assertNotIn("workflow_execute", source)
        self.assertNotIn("task_delete", source)
        self.assertNotIn("url_fetch", source)


if __name__ == "__main__":
    unittest.main()
