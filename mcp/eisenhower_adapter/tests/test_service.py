import json
import unittest
from pathlib import Path

from eisenhower_mcp.service import EisenhowerMcpService


class FakeApiClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, str]]] = []

    def list_tasks(self) -> list[dict[str, object]]:
        self.calls.append(("GET /tasks", {}))
        return [
            {
                "_id": "task-1",
                "title": "Napraw alarm",
                "description": "Produkcja",
                "urgent": True,
                "important": True,
            },
            {
                "_id": "task-2",
                "title": "Deleguj raport",
                "description": "Raport tygodniowy",
                "urgent": True,
                "important": False,
            },
            {
                "_id": "task-3",
                "title": "Zaplanuj roadmapę",
                "description": "Projekt alpha",
                "urgent": False,
                "important": True,
                "projectId": "alpha",
            },
            {
                "_id": "task-4",
                "title": "Usuń newsletter",
                "description": "Nieistotne",
                "urgent": False,
                "important": False,
            },
        ]

    def search_knowledge(self, query: str, project_id: str | None, limit: int) -> dict[str, object]:
        self.calls.append(
            (
                "POST /v2/knowledge/search",
                {"query": query, "project_id": project_id or "", "limit": str(limit)},
            )
        )
        return {
            "answer": None,
            "citations": [
                {
                    "document_id": "doc-1",
                    "chunk_id": "chunk-1",
                    "title": "Runbook",
                    "snippet": "Sprawdź alarm",
                    "score": 0.91,
                }
            ],
        }


class EisenhowerMcpServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.api = FakeApiClient()
        self.service = EisenhowerMcpService(self.api)

    def test_matrix_summary_uses_canonical_quadrants(self) -> None:
        result = self.service.matrix_summary()
        contract_path = Path(__file__).resolve().parents[3] / "contracts" / "quadrants.json"
        contract = json.loads(contract_path.read_text(encoding="utf-8"))

        self.assertEqual(
            result["quadrants"],
            {str(item["value"]): {"label": item["name"], "count": 1} for item in contract},
        )

    def test_tasks_search_is_read_only_and_bounded(self) -> None:
        result = self.service.tasks_search(query="raport", limit=1)

        self.assertEqual([task["id"] for task in result["tasks"]], ["task-2"])
        self.assertEqual(self.api.calls, [("GET /tasks", {})])

    def test_task_get_resolves_from_existing_list_endpoint(self) -> None:
        result = self.service.task_get("task-3")

        self.assertEqual(result["task"]["quadrant"], 2)
        self.assertEqual(result["task"]["quadrant_label"], "Schedule")

    def test_project_context_does_not_invent_missing_project_data(self) -> None:
        result = self.service.project_context("alpha")

        self.assertEqual(result["project_id"], "alpha")
        self.assertEqual([task["id"] for task in result["tasks"]], ["task-3"])
        self.assertEqual(result["limitations"], ["Project metadata is not exposed by the current public API."])

    def test_knowledge_search_preserves_citations(self) -> None:
        result = self.service.knowledge_search("alarm", project_id="alpha", limit=3)

        self.assertEqual(result["citations"][0]["chunk_id"], "chunk-1")
        self.assertEqual(self.api.calls[-1][0], "POST /v2/knowledge/search")

    def test_priority_explain_is_deterministic_and_read_only(self) -> None:
        result = self.service.priority_explain("task-2")

        self.assertEqual(result["quadrant"], 1)
        self.assertEqual(result["quadrant_label"], "Delegate")
        self.assertIn("urgent", result["explanation"])

    def test_unknown_task_has_typed_not_found_error(self) -> None:
        with self.assertRaisesRegex(LookupError, "Task not found"):
            self.service.task_get("missing")


if __name__ == "__main__":
    unittest.main()
