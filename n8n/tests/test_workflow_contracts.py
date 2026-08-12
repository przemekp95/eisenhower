import json
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]


def load_workflow(name: str) -> dict:
    return json.loads(ROOT.joinpath("workflows", name).read_text(encoding="utf-8"))


class IngestionWorkflowContractTest(unittest.TestCase):
    def test_schema_requires_monotonic_source_sequence(self) -> None:
        schema = json.loads(
            ROOT.joinpath("contracts/ingestion-event.schema.json").read_text(encoding="utf-8")
        )

        self.assertEqual(schema["properties"]["schema_version"]["const"], "2")
        self.assertIn("source_sequence", schema["required"])
        self.assertEqual(schema["properties"]["source_sequence"]["minimum"], 0)

    def test_ingestion_is_authenticated_async_and_never_on_analyze_path(self) -> None:
        workflow = load_workflow("async-rag-ingestion.json")
        serialized = json.dumps(workflow)
        nodes = {node["name"]: node for node in workflow["nodes"]}

        webhook = nodes["Receive Signed Ingestion Event"]
        self.assertEqual(webhook["parameters"]["httpMethod"], "POST")
        self.assertEqual(webhook["parameters"]["authentication"], "headerAuth")
        self.assertEqual(webhook["parameters"]["responseMode"], "responseNode")
        self.assertTrue(webhook["parameters"]["options"]["rawBody"])
        self.assertNotIn("/analyze", serialized)
        self.assertNotIn("analyze-langchain", serialized)
        self.assertIn("Verify Signature And Replay Window", nodes)
        self.assertIn("Respond 202 Accepted", nodes)

        verification = nodes["Verify Signature And Replay Window"]["parameters"]
        self.assertEqual(verification["contentType"], "binaryData")
        self.assertEqual(verification["inputDataFieldName"], "data")
        self.assertNotIn("body", verification)
        verification_headers = {
            entry["name"]: entry["value"]
            for entry in verification["headerParameters"]["parameters"]
        }
        self.assertEqual(verification_headers["X-Eisenhower-Signed-Method"], "POST")
        self.assertEqual(
            verification_headers["X-Eisenhower-Signed-Path"],
            "/webhook/eisenhower-rag-ingestion",
        )
        self.assertIn(
            "x-eisenhower-signature-version",
            verification_headers["X-Eisenhower-Signature-Version"],
        )

    def test_routes_only_named_ingestion_operations(self) -> None:
        workflow = load_workflow("async-rag-ingestion.json")
        serialized = json.dumps(workflow)

        for operation in ("upsert", "tombstone", "reindex_project", "start_rag_evaluation"):
            self.assertIn(operation, serialized)
        for forbidden in ("execute_any", "workflow_execute", "shell", "command"):
            self.assertNotIn(forbidden, serialized)

    def test_each_job_dispatch_has_idempotency_and_bounded_retry(self) -> None:
        workflow = load_workflow("async-rag-ingestion.json")
        dispatches = [node for node in workflow["nodes"] if node["name"].startswith("Dispatch ")]

        self.assertEqual(len(dispatches), 4)
        for node in dispatches:
            self.assertTrue(node["retryOnFail"])
            self.assertGreaterEqual(node["maxTries"], 3)
            self.assertGreaterEqual(node["waitBetweenTries"], 1000)
            rendered = json.dumps(node)
            self.assertIn("Idempotency-Key", rendered)
            self.assertIn("X-Eisenhower-Signature", rendered)
            self.assertIn("source_version", rendered)
            self.assertIn("source_sequence", rendered)
            self.assertIn("embedding_version", rendered)
            self.assertIn("chunking_version", rendered)

    def test_error_workflow_uses_error_trigger_and_retrying_alert(self) -> None:
        workflow = load_workflow("rag-ingestion-error.json")
        nodes = {node["name"]: node for node in workflow["nodes"]}

        self.assertEqual(nodes["Workflow Error"]["type"], "n8n-nodes-base.errorTrigger")
        alert = nodes["Send Sanitized Alert"]
        self.assertTrue(alert["retryOnFail"])
        self.assertNotIn("executionData", json.dumps(alert))


if __name__ == "__main__":
    unittest.main()
