import asyncio
import unittest
from unittest.mock import Mock, patch

from mcp.client import Client

from eisenhower_mcp import server
from eisenhower_mcp.http_client import EisenhowerApiClient
from eisenhower_mcp.service import EisenhowerMcpService


class WriteApi:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple, dict]] = []

    def create_task(self, payload, idempotency_key):
        self.calls.append(("create_task", (payload, idempotency_key), {}))
        return {"_id": "task-1", **payload, "revision": 0}

    def update_task(self, task_id, expected_revision, patch, idempotency_key):
        self.calls.append(
            ("update_task", (task_id, expected_revision, patch, idempotency_key), {})
        )
        return {"_id": task_id, **patch, "revision": expected_revision + 1}

    def transition_task_lifecycle(self, task_id, expected_revision, action, idempotency_key):
        self.calls.append(
            (
                "transition_task_lifecycle",
                (task_id, expected_revision, action, idempotency_key),
                {},
            )
        )
        return {"_id": task_id, "lifecycleState": "completed", "revision": 2}

    def update_task_schedule(self, task_id, expected_revision, schedule, idempotency_key):
        self.calls.append(
            ("update_task_schedule", (task_id, expected_revision, schedule, idempotency_key), {})
        )
        return {"_id": task_id, "schedule": schedule, "revision": 3}

    def update_task_delegation(self, task_id, expected_revision, delegation, idempotency_key):
        self.calls.append(
            (
                "update_task_delegation",
                (task_id, expected_revision, delegation, idempotency_key),
                {},
            )
        )
        return {"_id": task_id, "delegation": delegation, "revision": 4}

    def transition_task_delegation(self, task_id, expected_revision, status, idempotency_key):
        self.calls.append(
            (
                "transition_task_delegation",
                (task_id, expected_revision, status, idempotency_key),
                {},
            )
        )
        return {"_id": task_id, "delegation": {"status": status}, "revision": 5}

    def calendar_sync_status(self):
        self.calls.append(("calendar_sync_status", (), {}))
        return {"status": "connected"}

    def request_calendar_sync(self, idempotency_key):
        self.calls.append(("request_calendar_sync", (idempotency_key,), {}))
        return {"status": "pending"}

    def list_calendar_conflicts(self):
        self.calls.append(("list_calendar_conflicts", (), {}))
        return [{"_id": "conflict-1", "revision": 2}]

    def resolve_calendar_conflict(
        self, conflict_id, expected_revision, strategy, idempotency_key
    ):
        self.calls.append(
            (
                "resolve_calendar_conflict",
                (conflict_id, expected_revision, strategy, idempotency_key),
                {},
            )
        )
        return {"_id": conflict_id, "status": "resolved_local", "revision": 3}


class WriteServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.api = WriteApi()
        self.service = EisenhowerMcpService(self.api)

    def test_create_update_and_lifecycle_are_narrow_revision_safe_commands(self) -> None:
        created = self.service.task_create("Ship", "create-1", important=True)
        updated = self.service.task_update(
            "task-1", 0, "update-1", description="Ready", urgent=True
        )
        completed = self.service.task_lifecycle("task-1", 1, "complete", "lifecycle-1")

        self.assertEqual(created["task"]["revision"], 0)
        self.assertEqual(updated["task"]["description"], "Ready")
        self.assertEqual(completed["task"]["lifecycle_state"], "completed")
        self.assertEqual(
            self.api.calls[:3],
            [
                (
                    "create_task",
                    (
                        {
                            "title": "Ship",
                            "description": "",
                            "urgent": False,
                            "important": True,
                        },
                        "create-1",
                    ),
                    {},
                ),
                (
                    "update_task",
                    ("task-1", 0, {"description": "Ready", "urgent": True}, "update-1"),
                    {},
                ),
                (
                    "transition_task_lifecycle",
                    ("task-1", 1, "complete", "lifecycle-1"),
                    {},
                ),
            ],
        )

    def test_schedule_and_delegation_require_one_explicit_mode(self) -> None:
        scheduled = self.service.task_schedule(
            "task-1",
            2,
            "schedule-1",
            due_at="2026-08-15T12:00:00.000Z",
            time_zone="Europe/Warsaw",
        )
        delegated = self.service.task_delegation(
            "task-1",
            3,
            "delegation-1",
            assignee_user_id="user-b",
            display_label="Pat",
        )
        transitioned = self.service.task_delegation(
            "task-1", 4, "delegation-2", status="accepted"
        )

        self.assertEqual(scheduled["task"]["revision"], 3)
        self.assertEqual(delegated["task"]["delegation"]["assigneeUserId"], "user-b")
        self.assertEqual(transitioned["task"]["delegation"]["status"], "accepted")
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.service.task_schedule("task-1", 5, "schedule-2")
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.service.task_delegation(
                "task-1", 5, "delegation-3", status="blocked", clear=True
            )

    def test_rejects_empty_idempotency_keys_invalid_revisions_and_empty_updates(self) -> None:
        with self.assertRaisesRegex(ValueError, "idempotency_key"):
            self.service.task_create("Ship", "")
        with self.assertRaisesRegex(ValueError, "expected_revision"):
            self.service.task_lifecycle("task-1", -1, "complete", "lifecycle-1")
        with self.assertRaisesRegex(ValueError, "at least one"):
            self.service.task_update("task-1", 0, "update-1")

    def test_calendar_sync_uses_explicit_status_and_request_ports(self) -> None:
        self.assertEqual(self.service.calendar_sync_status()["status"], "connected")
        self.assertEqual(
            self.service.calendar_sync_request("calendar-1")["status"], "pending"
        )
        self.assertEqual(
            self.api.calls[-2:],
            [
                ("calendar_sync_status", (), {}),
                ("request_calendar_sync", ("calendar-1",), {}),
            ],
        )

    def test_calendar_conflicts_use_list_and_revision_safe_resolution_ports(self) -> None:
        conflicts = self.service.calendar_conflicts_list()
        resolved = self.service.calendar_conflict_resolve(
            "conflict-1", 2, "eisenhower", "resolve-1"
        )

        self.assertEqual(conflicts["conflicts"][0]["_id"], "conflict-1")
        self.assertEqual(resolved["conflict"]["revision"], 3)
        self.assertEqual(
            self.api.calls[-2:],
            [
                ("list_calendar_conflicts", (), {}),
                (
                    "resolve_calendar_conflict",
                    ("conflict-1", 2, "eisenhower", "resolve-1"),
                    {},
                ),
            ],
        )
        with self.assertRaisesRegex(ValueError, "strategy"):
            self.service.calendar_conflict_resolve(
                "conflict-1", 2, "delete", "resolve-2"
            )


class WriteHttpClientTest(unittest.TestCase):
    @patch("eisenhower_mcp.http_client.urlopen")
    def test_maps_commands_to_fixed_paths_and_required_safety_headers(self, mocked_open) -> None:
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=None)
        response.read.return_value = b'{"_id":"task-1","revision":1}'
        response.headers = {}
        mocked_open.return_value = response
        client = EisenhowerApiClient("https://api.example.test", "https://ai.example.test")

        client.create_task({"title": "Ship"}, "create-1")
        client.update_task("task-1", 0, {"urgent": True}, "update-1")
        client.transition_task_lifecycle("task-1", 1, "complete", "lifecycle-1")
        client.update_task_schedule("task-1", 2, None, "schedule-1")
        client.update_task_delegation("task-1", 3, None, "delegation-1")
        client.transition_task_delegation("task-1", 4, "accepted", "delegation-2")

        requests = [call.args[0] for call in mocked_open.call_args_list]
        self.assertEqual(
            [(request.method, request.full_url) for request in requests],
            [
                ("POST", "https://api.example.test/tasks"),
                ("PUT", "https://api.example.test/tasks/task-1"),
                ("PUT", "https://api.example.test/tasks/task-1/lifecycle"),
                ("PUT", "https://api.example.test/tasks/task-1/schedule"),
                ("PUT", "https://api.example.test/tasks/task-1/delegation"),
                ("PUT", "https://api.example.test/tasks/task-1/delegation/status"),
            ],
        )
        self.assertEqual(requests[0].headers["Idempotency-key"], "create-1")
        for revision, request in enumerate(requests[1:]):
            self.assertEqual(request.headers["If-match"], f'"{revision}"')
            self.assertTrue(request.headers["Idempotency-key"])

    @patch("eisenhower_mcp.http_client.urlopen")
    def test_calendar_methods_use_only_the_published_fixed_endpoints(self, mocked_open) -> None:
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=None)
        response.read.return_value = b'{"status":"pending"}'
        response.headers = {}
        mocked_open.return_value = response
        client = EisenhowerApiClient("https://api.example.test", "https://ai.example.test")

        client.calendar_sync_status()
        client.request_calendar_sync("calendar-1")

        status_request, sync_request = [call.args[0] for call in mocked_open.call_args_list]
        self.assertEqual(
            (status_request.method, status_request.full_url),
            ("GET", "https://api.example.test/calendar/status"),
        )
        self.assertEqual(
            (sync_request.method, sync_request.full_url),
            ("POST", "https://api.example.test/calendar/sync-requests"),
        )
        self.assertEqual(sync_request.headers["Idempotency-key"], "calendar-1")

    @patch("eisenhower_mcp.http_client.urlopen")
    def test_calendar_conflicts_use_only_fixed_list_and_resolution_paths(self, mocked_open) -> None:
        responses = []
        for body in (b'[{"_id":"conflict-1","revision":2}]', b'{"_id":"conflict-1","revision":3}'):
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=None)
            response.read.return_value = body
            response.headers = {}
            responses.append(response)
        mocked_open.side_effect = responses
        client = EisenhowerApiClient("https://api.example.test", "https://ai.example.test")

        client.list_calendar_conflicts()
        client.resolve_calendar_conflict("conflict-1", 2, "google", "resolve-1")

        list_request, resolve_request = [call.args[0] for call in mocked_open.call_args_list]
        self.assertEqual(
            (list_request.method, list_request.full_url),
            ("GET", "https://api.example.test/calendar/conflicts"),
        )
        self.assertEqual(
            (resolve_request.method, resolve_request.full_url),
            ("POST", "https://api.example.test/calendar/conflicts/conflict-1/resolve"),
        )
        self.assertEqual(resolve_request.headers["If-match"], '"2"')
        self.assertEqual(resolve_request.headers["Idempotency-key"], "resolve-1")


class WriteServerContractTest(unittest.TestCase):
    def test_lists_narrow_write_tools_with_approval_safe_annotations(self) -> None:
        async def verify() -> None:
            async with Client(server.mcp) as client:
                tools = {tool.name: tool for tool in (await client.list_tools()).tools}

            expected = {
                "task_create",
                "task_update",
                "task_lifecycle",
                "task_schedule",
                "task_delegation",
                "calendar_sync_status",
                "calendar_sync_request",
                "calendar_conflicts_list",
                "calendar_conflict_resolve",
            }
            self.assertTrue(expected.issubset(tools))
            for name in expected - {"calendar_sync_status", "calendar_conflicts_list"}:
                self.assertFalse(tools[name].annotations.read_only_hint)
                self.assertFalse(tools[name].annotations.destructive_hint)
                self.assertTrue(tools[name].annotations.idempotent_hint)
                self.assertFalse(tools[name].annotations.open_world_hint)
            self.assertTrue(tools["calendar_sync_status"].annotations.read_only_hint)
            self.assertFalse(tools["calendar_sync_status"].annotations.destructive_hint)
            self.assertTrue(tools["calendar_conflicts_list"].annotations.read_only_hint)
            self.assertFalse(tools["calendar_conflicts_list"].annotations.destructive_hint)

            for name in {
                "task_update",
                "task_lifecycle",
                "task_schedule",
                "task_delegation",
                "calendar_conflict_resolve",
            }:
                required = set(tools[name].input_schema["required"])
                self.assertIn("expected_revision", required)
                self.assertIn("idempotency_key", required)
            sync_required = set(tools["calendar_sync_request"].input_schema["required"])
            self.assertEqual(sync_required, {"idempotency_key"})

        asyncio.run(verify())

    def test_write_tool_audit_remains_content_free(self) -> None:
        write_service = Mock()
        write_service.task_create.return_value = {"task": {"id": "task-1", "revision": 0}}
        recorder = Mock()
        original_service = server.service
        original_audit = server.audit_recorder
        server.service = write_service
        server.audit_recorder = recorder
        try:
            async def call():
                async with Client(server.mcp) as client:
                    return await client.call_tool(
                        "task_create",
                        {"title": "private title", "idempotency_key": "private-key"},
                    )

            result = asyncio.run(call())
        finally:
            server.service = original_service
            server.audit_recorder = original_audit

        self.assertFalse(result.is_error)
        audit_repr = repr(recorder.record_tool.call_args_list)
        self.assertNotIn("private title", audit_repr)
        self.assertNotIn("private-key", audit_repr)


if __name__ == "__main__":
    unittest.main()
