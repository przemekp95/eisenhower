from __future__ import annotations

import re
from typing import Any, Literal, Protocol


QUADRANTS: dict[int, str] = {
    0: "Do Now",
    1: "Delegate",
    2: "Schedule",
    3: "Delete",
}


LifecycleAction = Literal["complete", "reopen", "archive", "trash", "restore"]
DelegationStatus = Literal["offered", "accepted", "in_progress", "blocked", "completed", "declined"]
_IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


class ApiClient(Protocol):
    def list_tasks(self) -> list[dict[str, Any]]: ...

    def search_knowledge(self, query: str, project_id: str | None, limit: int) -> dict[str, Any]: ...

    def create_task(self, payload: dict[str, Any], idempotency_key: str) -> dict[str, Any]: ...

    def update_task(
        self, task_id: str, expected_revision: int, patch: dict[str, Any], idempotency_key: str
    ) -> dict[str, Any]: ...

    def transition_task_lifecycle(
        self, task_id: str, expected_revision: int, action: str, idempotency_key: str
    ) -> dict[str, Any]: ...

    def update_task_schedule(
        self, task_id: str, expected_revision: int, schedule: dict[str, Any] | None,
        idempotency_key: str,
    ) -> dict[str, Any]: ...

    def update_task_delegation(
        self, task_id: str, expected_revision: int, delegation: dict[str, Any] | None,
        idempotency_key: str,
    ) -> dict[str, Any]: ...

    def transition_task_delegation(
        self, task_id: str, expected_revision: int, status: str, idempotency_key: str
    ) -> dict[str, Any]: ...

    def calendar_sync_status(self) -> dict[str, Any]: ...

    def request_calendar_sync(self, idempotency_key: str) -> dict[str, Any]: ...

    def list_calendar_conflicts(self) -> list[dict[str, Any]]: ...

    def resolve_calendar_conflict(
        self, conflict_id: str, expected_revision: int, strategy: str, idempotency_key: str
    ) -> dict[str, Any]: ...


def _quadrant(task: dict[str, Any]) -> int:
    urgent = bool(task.get("urgent", False))
    important = bool(task.get("important", False))
    if urgent and important:
        return 0
    if urgent:
        return 1
    if important:
        return 2
    return 3


def _task_view(task: dict[str, Any]) -> dict[str, Any]:
    quadrant = _quadrant(task)
    return {
        "id": str(task.get("_id", task.get("id", ""))),
        "title": str(task.get("title", "")),
        "description": str(task.get("description", "")),
        "urgent": bool(task.get("urgent", False)),
        "important": bool(task.get("important", False)),
        "quadrant": quadrant,
        "quadrant_label": QUADRANTS[quadrant],
        "project_id": task.get("projectId", task.get("project_id")),
        "created_at": task.get("createdAt", task.get("created_at")),
        "updated_at": task.get("updatedAt", task.get("updated_at")),
        "lifecycle_state": task.get("lifecycleState", task.get("lifecycle_state")),
        "revision": task.get("revision"),
        "schedule": task.get("schedule"),
        "delegation": task.get("delegation"),
    }


class EisenhowerMcpService:
    """Narrow application boundary over Eisenhower task and knowledge APIs."""

    def __init__(self, api_client: ApiClient) -> None:
        self._api = api_client

    def matrix_summary(self) -> dict[str, Any]:
        tasks = [_task_view(task) for task in self._api.list_tasks()]
        counts = {quadrant: 0 for quadrant in QUADRANTS}
        for task in tasks:
            counts[int(task["quadrant"])] += 1
        return {
            "total": len(tasks),
            "quadrants": {
                str(quadrant): {"label": label, "count": counts[quadrant]}
                for quadrant, label in QUADRANTS.items()
            },
        }

    def tasks_search(self, query: str = "", limit: int = 20) -> dict[str, Any]:
        bounded_limit = max(1, min(limit, 100))
        needle = query.strip().casefold()
        tasks = [_task_view(task) for task in self._api.list_tasks()]
        matches = [
            task
            for task in tasks
            if not needle or needle in f'{task["title"]} {task["description"]}'.casefold()
        ]
        return {"tasks": matches[:bounded_limit], "count": min(len(matches), bounded_limit)}

    def task_get(self, task_id: str) -> dict[str, Any]:
        task_id = task_id.strip()
        if not task_id:
            raise ValueError("task_id is required")
        for raw_task in self._api.list_tasks():
            task = _task_view(raw_task)
            if task["id"] == task_id:
                return {"task": task}
        raise LookupError("Task not found")

    def project_context(self, project_id: str, limit: int = 100) -> dict[str, Any]:
        project_id = project_id.strip()
        if not project_id:
            raise ValueError("project_id is required")
        tasks = [_task_view(task) for task in self._api.list_tasks()]
        matching = [task for task in tasks if task["project_id"] == project_id][: max(1, min(limit, 100))]
        return {
            "project_id": project_id,
            "tasks": matching,
            "limitations": ["Project metadata is not exposed by the current public API."],
        }

    def knowledge_search(self, query: str, project_id: str | None = None, limit: int = 5) -> dict[str, Any]:
        query = query.strip()
        if not query:
            raise ValueError("query is required")
        return self._api.search_knowledge(query, project_id, max(1, min(limit, 20)))

    def priority_explain(self, task_id: str) -> dict[str, Any]:
        task = self.task_get(task_id)["task"]
        urgent = bool(task["urgent"])
        important = bool(task["important"])
        explanation = (
            f'The task is {"urgent" if urgent else "not urgent"} and '
            f'{"important" if important else "not important"}; therefore it belongs to '
            f'quadrant {task["quadrant"]} ({task["quadrant_label"]}).'
        )
        return {
            "task_id": task["id"],
            "quadrant": task["quadrant"],
            "quadrant_label": task["quadrant_label"],
            "explanation": explanation,
            "source": "deterministic_eisenhower_rules",
        }

    def task_create(
        self,
        title: str,
        idempotency_key: str,
        description: str = "",
        urgent: bool = False,
        important: bool = False,
    ) -> dict[str, Any]:
        title = title.strip()
        if not title:
            raise ValueError("title is required")
        self._validate_idempotency_key(idempotency_key)
        task = self._api.create_task(
            {
                "title": title,
                "description": description.strip(),
                "urgent": urgent,
                "important": important,
            },
            idempotency_key,
        )
        return {"task": _task_view(task)}

    def task_update(
        self,
        task_id: str,
        expected_revision: int,
        idempotency_key: str,
        title: str | None = None,
        description: str | None = None,
        urgent: bool | None = None,
        important: bool | None = None,
    ) -> dict[str, Any]:
        task_id = self._validate_command(task_id, expected_revision, idempotency_key)
        patch: dict[str, Any] = {}
        if title is not None:
            title = title.strip()
            if not title:
                raise ValueError("title must not be empty")
            patch["title"] = title
        if description is not None:
            patch["description"] = description.strip()
        if urgent is not None:
            patch["urgent"] = urgent
        if important is not None:
            patch["important"] = important
        if not patch:
            raise ValueError("at least one task field is required")
        task = self._api.update_task(task_id, expected_revision, patch, idempotency_key)
        return {"task": _task_view(task)}

    def task_lifecycle(
        self,
        task_id: str,
        expected_revision: int,
        action: LifecycleAction,
        idempotency_key: str,
    ) -> dict[str, Any]:
        task_id = self._validate_command(task_id, expected_revision, idempotency_key)
        if action not in {"complete", "reopen", "archive", "trash", "restore"}:
            raise ValueError("action is invalid")
        task = self._api.transition_task_lifecycle(
            task_id, expected_revision, action, idempotency_key
        )
        return {"task": _task_view(task)}

    def task_schedule(
        self,
        task_id: str,
        expected_revision: int,
        idempotency_key: str,
        due_at: str | None = None,
        time_zone: str | None = None,
        remind_at: str | None = None,
        clear: bool = False,
    ) -> dict[str, Any]:
        task_id = self._validate_command(task_id, expected_revision, idempotency_key)
        has_schedule = due_at is not None or time_zone is not None or remind_at is not None
        if clear == has_schedule:
            raise ValueError("exactly one schedule mode is required: fields or clear")
        if clear:
            schedule = None
        else:
            if not due_at or not time_zone:
                raise ValueError("due_at and time_zone are required together")
            schedule = {"dueAt": due_at, "timeZone": time_zone}
            if remind_at is not None:
                schedule["remindAt"] = remind_at
        task = self._api.update_task_schedule(
            task_id, expected_revision, schedule, idempotency_key
        )
        return {"task": _task_view(task)}

    def task_delegation(
        self,
        task_id: str,
        expected_revision: int,
        idempotency_key: str,
        assignee_user_id: str | None = None,
        display_label: str | None = None,
        handoff_note: str = "",
        status: DelegationStatus | None = None,
        clear: bool = False,
    ) -> dict[str, Any]:
        task_id = self._validate_command(task_id, expected_revision, idempotency_key)
        has_assignment = assignee_user_id is not None or display_label is not None
        if sum((has_assignment, status is not None, clear)) != 1:
            raise ValueError("exactly one delegation mode is required: assignment, status, or clear")
        if status is not None:
            if status not in {"offered", "accepted", "in_progress", "blocked", "completed", "declined"}:
                raise ValueError("status is invalid")
            task = self._api.transition_task_delegation(
                task_id, expected_revision, status, idempotency_key
            )
        else:
            if clear:
                delegation = None
            else:
                if not assignee_user_id or not assignee_user_id.strip():
                    raise ValueError("assignee_user_id is required")
                if not display_label or not display_label.strip():
                    raise ValueError("display_label is required")
                delegation = {
                    "assigneeUserId": assignee_user_id.strip(),
                    "displayLabel": display_label.strip(),
                    "handoffNote": handoff_note.strip(),
                }
            task = self._api.update_task_delegation(
                task_id, expected_revision, delegation, idempotency_key
            )
        return {"task": _task_view(task)}

    def calendar_sync_status(self) -> dict[str, Any]:
        return self._api.calendar_sync_status()

    def calendar_sync_request(self, idempotency_key: str) -> dict[str, Any]:
        self._validate_idempotency_key(idempotency_key)
        return self._api.request_calendar_sync(idempotency_key)

    def calendar_conflicts_list(self) -> dict[str, Any]:
        conflicts = self._api.list_calendar_conflicts()
        return {"conflicts": conflicts, "count": len(conflicts)}

    def calendar_conflict_resolve(
        self,
        conflict_id: str,
        expected_revision: int,
        strategy: Literal["eisenhower", "google"],
        idempotency_key: str,
    ) -> dict[str, Any]:
        conflict_id = conflict_id.strip()
        if not conflict_id:
            raise ValueError("conflict_id is required")
        self._validate_revision(expected_revision)
        self._validate_idempotency_key(idempotency_key)
        if strategy not in {"eisenhower", "google"}:
            raise ValueError("strategy must be eisenhower or google")
        conflict = self._api.resolve_calendar_conflict(
            conflict_id, expected_revision, strategy, idempotency_key
        )
        return {"conflict": conflict}

    @classmethod
    def _validate_command(
        cls, task_id: str, expected_revision: int, idempotency_key: str
    ) -> str:
        task_id = task_id.strip()
        if not task_id:
            raise ValueError("task_id is required")
        cls._validate_revision(expected_revision)
        cls._validate_idempotency_key(idempotency_key)
        return task_id

    @staticmethod
    def _validate_revision(expected_revision: int) -> None:
        if (
            isinstance(expected_revision, bool)
            or not isinstance(expected_revision, int)
            or expected_revision < 0
        ):
            raise ValueError("expected_revision must be a non-negative integer")

    @staticmethod
    def _validate_idempotency_key(idempotency_key: str) -> None:
        if not _IDEMPOTENCY_KEY.fullmatch(idempotency_key):
            raise ValueError("idempotency_key must contain 1-128 URL-safe characters")
