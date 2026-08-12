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


class CalendarWorkflowContractTest(unittest.TestCase):
    WORKFLOWS = (
        "calendar-outbound.json",
        "calendar-inbound.json",
        "calendar-reconciliation.json",
    )

    def test_every_node_internal_request_uses_exact_raw_json_hmac_contract(self) -> None:
        for workflow_name in self.WORKFLOWS:
            workflow = load_workflow(workflow_name)
            self.assertFalse(workflow["active"])
            nodes = {node["name"]: node for node in workflow["nodes"]}
            serialized = json.dumps(workflow)
            self.assertNotIn("EISENHOWER_INTERNAL_API_TOKEN", serialized)
            self.assertNotIn('"Authorization"', serialized)

            signing_nodes = [node for node in workflow["nodes"] if node["name"].startswith("Sign ")]
            self.assertTrue(signing_nodes, workflow_name)
            for signer in signing_nodes:
                code = signer["parameters"]["jsCode"]
                self.assertIn("require('crypto')", code)
                self.assertIn("JSON.stringify(body)", code)
                self.assertIn("v1\\n${timestamp}\\nPOST\\n${path}\\n${rawBody}", code)

            internal_requests = []
            for node in workflow["nodes"]:
                if node["type"] != "n8n-nodes-base.httpRequest":
                    continue
                url = str(node["parameters"].get("url", ""))
                if "/internal/calendar/" not in url:
                    continue
                internal_requests.append(node)
                parameters = node["parameters"]
                self.assertEqual(parameters["contentType"], "raw", node["name"])
                self.assertEqual(parameters["rawContentType"], "application/json", node["name"])
                self.assertEqual(parameters["body"], "={{ $json.signedBody }}", node["name"])
                headers = {
                    header["name"]: header["value"]
                    for header in parameters["headerParameters"]["parameters"]
                }
                self.assertEqual(headers["X-Eisenhower-Timestamp"], "={{ $json.signedTimestamp }}")
                self.assertEqual(headers["X-Eisenhower-Signature"], "={{ $json.signedSignature }}")

            self.assertEqual(len(signing_nodes), len(internal_requests), workflow_name)

            self.assertIn("Sign ", " ".join(nodes))

    def test_calendar_workflows_are_importable_inactive_graphs(self) -> None:
        for workflow_name in self.WORKFLOWS:
            workflow = load_workflow(workflow_name)
            node_names = {node["name"] for node in workflow["nodes"]}
            self.assertFalse(workflow["active"])
            self.assertEqual(workflow["settings"]["saveDataSuccessExecution"], "none")
            for source, outputs in workflow["connections"].items():
                self.assertIn(source, node_names, workflow_name)
                for branch in outputs["main"]:
                    for target in branch:
                        self.assertIn(target["node"], node_names, workflow_name)

    def test_calendar_internal_dtos_are_camel_case_and_cover_backend_routes(self) -> None:
        serialized = "\n".join(json.dumps(load_workflow(name)) for name in self.WORKFLOWS)
        for forbidden in (
            "operation_id", "tenant_id", "owner_id", "connection_id", "calendar_id",
            "credential_ref", "event_id", "provider_event_id", "provider_etag",
            "channel_id", "resource_id", "expires_at", "sync_token", "page_token",
        ):
            self.assertNotIn(forbidden, serialized)
        for path in (
            "/internal/calendar/connections/activate",
            "/internal/calendar/outbox/claim",
            "/internal/calendar/outbox/acknowledge",
            "/internal/calendar/notifications/validate",
            "/internal/calendar/sync/apply",
            "/internal/calendar/sync/reset",
            "/internal/calendar/reconciliation/claim",
            "/internal/calendar/watch/renew",
        ):
            self.assertIn(path, serialized)

    def test_outbound_calendar_sync_is_private_bounded_and_acknowledged(self) -> None:
        workflow = load_workflow("calendar-outbound.json")
        nodes = {node["name"]: node for node in workflow["nodes"]}
        serialized = json.dumps(workflow)

        self.assertFalse(workflow["active"])
        self.assertEqual(nodes["Poll Calendar Outbox"]["type"], "n8n-nodes-base.scheduleTrigger")
        self.assertIn("/internal/calendar/outbox/claim", serialized)
        self.assertIn("/internal/calendar/outbox/acknowledge", serialized)
        for operation in ("event_create", "event_update", "event_delete"):
            self.assertIn(operation, serialized)
        for binding_field in ("eventId", "delivered", "providerEventId", "providerEtag", "connectionId"):
            self.assertIn(binding_field, serialized)
        for node_name in ("Create Google Event", "Update Google Event", "Delete Google Event"):
            node = nodes[node_name]
            self.assertTrue(node["retryOnFail"])
            self.assertGreaterEqual(node["maxTries"], 3)
            self.assertIn("googleOAuth2Api", json.dumps(node))
        self.assertNotIn("client_secret", serialized.lower())
        self.assertNotIn("refresh_token", serialized.lower())

    def test_inbound_notification_is_signal_only_and_uses_incremental_pull(self) -> None:
        workflow = load_workflow("calendar-inbound.json")
        nodes = {node["name"]: node for node in workflow["nodes"]}
        serialized = json.dumps(workflow)

        webhook = nodes["Receive Google Calendar Signal"]
        self.assertEqual(webhook["parameters"]["httpMethod"], "POST")
        self.assertEqual(webhook["parameters"]["responseMode"], "responseNode")
        self.assertIn("x-goog-channel-id", serialized.lower())
        self.assertIn("x-goog-resource-id", serialized.lower())
        self.assertIn("/internal/calendar/notifications/validate", serialized)
        self.assertIn("/internal/calendar/sync/apply", serialized)
        self.assertIn("syncToken", serialized)
        self.assertIn("nextPageToken", serialized)
        self.assertIn("nextSyncToken", serialized)
        self.assertIn("410", serialized)
        for kind in ("event_changed", "event_deleted", "sync_checkpoint"):
            self.assertIn(kind, serialized)
        self.assertNotIn("task_delete", serialized)

    def test_reconciliation_and_watch_renewal_are_scheduled(self) -> None:
        workflow = load_workflow("calendar-reconciliation.json")
        nodes = {node["name"]: node for node in workflow["nodes"]}
        serialized = json.dumps(workflow)

        self.assertEqual(nodes["Nightly Reconciliation"]["type"], "n8n-nodes-base.scheduleTrigger")
        self.assertIn("/internal/calendar/reconciliation/claim", serialized)
        self.assertIn("/internal/calendar/connections/activate", serialized)
        self.assertIn("/internal/calendar/watch/renew", serialized)
        self.assertIn("/internal/calendar/sync/apply", serialized)
        self.assertIn("googleOAuth2Api", serialized)
        self.assertNotIn("attendees", serialized)
        self.assertNotIn("conferenceData", serialized)


if __name__ == "__main__":
    unittest.main()
