from __future__ import annotations

from typing import Any, Protocol


QUADRANTS: dict[int, str] = {
    0: "Do Now",
    1: "Delegate",
    2: "Schedule",
    3: "Delete",
}


class ReadOnlyApiClient(Protocol):
    def list_tasks(self) -> list[dict[str, Any]]: ...

    def search_knowledge(self, query: str, project_id: str | None, limit: int) -> dict[str, Any]: ...


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
    }


class EisenhowerMcpService:
    """Query-only application service; no method can mutate upstream state."""

    def __init__(self, api_client: ReadOnlyApiClient) -> None:
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
