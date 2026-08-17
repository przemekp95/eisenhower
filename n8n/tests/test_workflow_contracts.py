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
                self.assertIn("randomUUID", code)
                self.assertIn("v1\\n${timestamp}\\n${requestId}\\nPOST\\n${path}\\n${rawBody}", code)

            internal_requests = []
            for node in workflow["nodes"]:
                if node["type"] != "n8n-nodes-base.httpRequest":
                    continue
                url = str(node["parameters"].get("url", ""))
                if "/internal/calendar/" not in url:
                    continue
                internal_requests.append(node)
                parameters = node["parameters"]
                if node["name"] in {
                    "Pull Provider Changes Through Node",
                    "Pull Reconciliation Changes Through Node",
                }:
                    self.assertEqual(parameters["contentType"], "json", node["name"])
                    self.assertEqual(parameters["specifyBody"], "json", node["name"])
                    self.assertEqual(parameters["jsonBody"], "={{ $json.signedBody }}", node["name"])
                else:
                    self.assertEqual(parameters["contentType"], "raw", node["name"])
                    self.assertEqual(parameters["rawContentType"], "application/json", node["name"])
                    self.assertEqual(parameters["body"], "={{ $json.signedBody }}", node["name"])
                headers = {
                    header["name"]: header["value"]
                    for header in parameters["headerParameters"]["parameters"]
                }
                self.assertEqual(headers["X-Eisenhower-Timestamp"], "={{ $json.signedTimestamp }}")
                self.assertEqual(headers["X-Eisenhower-Request-Id"], "={{ $json.signedRequestId }}")
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
            self.assertNotIn(f'"{forbidden}"', serialized)
        for path in (
            "/internal/calendar/outbox/claim",
            "/internal/calendar/outbox/acknowledge",
            "/internal/calendar/notifications/validate",
            "/internal/calendar/provider/outbound",
            "/internal/calendar/provider/changes",
            "/internal/calendar/provider/watch",
            "/internal/calendar/sync/apply",
            "/internal/calendar/sync/reset",
            "/internal/calendar/reconciliation/claim",
            "/internal/calendar/watch/renew",
        ):
            self.assertIn(path, serialized)

    def test_provider_access_is_tokenless_and_bounded_to_node_adapter(self) -> None:
        serialized = "\n".join(json.dumps(load_workflow(name)) for name in self.WORKFLOWS)
        for forbidden in (
            "googleOAuth2Api",
            "n8n-nodes-base.googleCalendar",
            "REPLACE_GOOGLE_CALENDAR_CREDENTIAL_ID",
            "client_secret",
            "refresh_token",
            "access_token",
            "https://www.googleapis.com",
            "credentialRef",
        ):
            self.assertNotIn(forbidden.lower(), serialized.lower())

        provider_paths = {
            "/internal/calendar/provider/outbound",
            "/internal/calendar/provider/changes",
            "/internal/calendar/provider/watch",
        }
        observed = set()
        for workflow_name in self.WORKFLOWS:
            workflow = load_workflow(workflow_name)
            for node in workflow["nodes"]:
                if node["type"] != "n8n-nodes-base.httpRequest":
                    continue
                url = str(node["parameters"].get("url", ""))
                for path in provider_paths:
                    if path in url:
                        observed.add(path)
                        self.assertTrue(node["retryOnFail"], node["name"])
                        self.assertGreaterEqual(node["maxTries"], 3, node["name"])
        self.assertEqual(observed, provider_paths)

        outbound = load_workflow("calendar-outbound.json")
        inbound = load_workflow("calendar-inbound.json")
        reconciliation = load_workflow("calendar-reconciliation.json")
        nodes = {
            node["name"]: node
            for workflow in (outbound, inbound, reconciliation)
            for node in workflow["nodes"]
        }
        expected_provider_bodies = {
            "Sign Outbound Provider Dispatch": "const body = { eventId: $json.eventId };",
            "Sign Provider Changes Pull": "const body = { connectionId: $json.connectionId, checkpoint };",
            "Sign Reconciliation Provider Changes": "const body = { connectionId: $json.connectionId, checkpoint };",
            "Sign Provider Watch Request": "const body = { connectionId: job.connectionId, address:",
        }
        for node_name, expected in expected_provider_bodies.items():
            code = nodes[node_name]["parameters"]["jsCode"]
            self.assertIn(expected, code)
            body_line = next(line for line in code.splitlines() if line.startswith("const body ="))
            self.assertNotIn("tenantId", body_line)
            self.assertNotIn("ownerId", body_line)
        for workflow in (inbound, reconciliation):
            serialized_workflow = json.dumps(workflow)
            self.assertIn("page.events", serialized_workflow)
            self.assertIn("resetRequired", serialized_workflow)
            self.assertIn("sync_token_gone", serialized_workflow)

    def test_outbound_calendar_sync_is_private_bounded_and_acknowledged(self) -> None:
        workflow = load_workflow("calendar-outbound.json")
        nodes = {node["name"]: node for node in workflow["nodes"]}
        serialized = json.dumps(workflow)

        self.assertFalse(workflow["active"])
        self.assertEqual(nodes["Poll Calendar Outbox"]["type"], "n8n-nodes-base.scheduleTrigger")
        self.assertIn("/internal/calendar/outbox/claim", serialized)
        self.assertIn("/internal/calendar/outbox/acknowledge", serialized)
        self.assertIn("/internal/calendar/provider/outbound", serialized)
        self.assertIn("Continue Only With Claimed Event", nodes)
        self.assertIn("typeof $json.eventId", nodes["Continue Only With Claimed Event"]["parameters"]["jsCode"])
        for binding_field in ("eventId", "leaseId", "delivered", "providerEventId", "providerEtag", "connectionId"):
            self.assertIn(binding_field, serialized)
        provider = nodes["Dispatch Outbound Through Node"]
        self.assertTrue(provider["retryOnFail"])
        self.assertGreaterEqual(provider["maxTries"], 3)
        self.assertNotIn("client_secret", serialized.lower())
        self.assertNotIn("refresh_token", serialized.lower())

        self.assertIn("Route Claimed Calendar Work", nodes)
        sync_signer = nodes["Sign Manual Sync Changes Pull"]["parameters"]["jsCode"]
        self.assertIn("/internal/calendar/provider/changes", sync_signer)
        self.assertIn("checkpoint", sync_signer)
        self.assertIn("Expand Manual Sync Changes", nodes)
        self.assertIn("/internal/calendar/sync/apply", serialized)

        provider_connections = workflow["connections"]["Dispatch Outbound Through Node"]["main"]
        self.assertGreaterEqual(len(provider_connections), 2)
        self.assertEqual(
            provider_connections[1][0]["node"],
            "Sign Outbox Failure Acknowledgement",
        )
        self.assertIn(
            "delivered: false",
            nodes["Sign Outbox Failure Acknowledgement"]["parameters"]["jsCode"],
        )

    def test_manual_sync_splits_large_change_sets_before_apply_batch(self) -> None:
        workflow = load_workflow("calendar-outbound.json")
        nodes = {node["name"]: node for node in workflow["nodes"]}
        expander = nodes["Expand Manual Sync Changes"]["parameters"]["jsCode"]

        self.assertIn("const batchSize = 250", expander)
        self.assertIn("commands.slice", expander)
        self.assertIn("return batches.map", expander)
        success_target = workflow["connections"]["Apply Manual Sync Page"]["main"][0][0]["node"]
        self.assertEqual(success_target, "Confirm Every Manual Sync Batch")
        confirmation = nodes[success_target]["parameters"]["jsCode"]
        self.assertIn("$('Expand Manual Sync Changes').all().length", confirmation)
        self.assertIn("$input.all().length", confirmation)
        self.assertEqual(
            workflow["connections"][success_target]["main"][0][0]["node"],
            "Sign Outbox Acknowledgement",
        )
        failure_target = workflow["connections"]["Apply Manual Sync Page"]["main"][1][0]["node"]
        self.assertEqual(failure_target, "Collapse Manual Sync Failures")
        self.assertEqual(
            workflow["connections"][failure_target]["main"][0][0]["node"],
            "Sign Outbox Failure Acknowledgement",
        )

    def test_inbound_notification_is_signal_only_and_uses_incremental_pull(self) -> None:
        workflow = load_workflow("calendar-inbound.json")
        nodes = {node["name"]: node for node in workflow["nodes"]}
        serialized = json.dumps(workflow)

        webhook = nodes["Receive Google Calendar Signal"]
        self.assertRegex(webhook["webhookId"], r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
        self.assertEqual(webhook["parameters"]["httpMethod"], "POST")
        self.assertEqual(webhook["parameters"]["responseMode"], "responseNode")
        self.assertIn("x-goog-channel-id", serialized.lower())
        self.assertIn("x-goog-resource-id", serialized.lower())
        self.assertIn("/internal/calendar/notifications/validate", serialized)
        self.assertIn("/internal/calendar/provider/changes", serialized)
        self.assertIn("/internal/calendar/sync/apply", serialized)
        self.assertIn("syncToken", serialized)
        self.assertIn("nextPageToken", serialized)
        self.assertIn("nextSyncToken", serialized)
        self.assertIn("resetRequired", serialized)
        for kind in ("event_changed", "event_deleted", "sync_checkpoint"):
            self.assertIn(kind, serialized)
        self.assertNotIn("task_delete", serialized)

        reset_if = nodes["Sync Token Is Gone"]
        self.assertEqual(reset_if["typeVersion"], 2.2)
        condition_options = reset_if["parameters"]["conditions"]["options"]
        self.assertEqual(condition_options["caseSensitive"], True)
        self.assertEqual(condition_options["typeValidation"], "strict")
        condition = reset_if["parameters"]["conditions"]["conditions"][0]
        self.assertEqual(condition["leftValue"], "={{ $json.resetRequired }}")
        self.assertEqual(condition["operator"]["type"], "boolean")
        self.assertEqual(condition["operator"]["operation"], "true")
        self.assertIn("$json.body ?? $json", nodes["Expand Provider Changes"]["parameters"]["jsCode"])

        validation = nodes["Sign Notification Validation"]["parameters"]["jsCode"]
        self.assertIn("x-goog-channel-token", validation)
        self.assertIn("channelToken", validation)

    def test_reconciliation_and_watch_renewal_are_scheduled(self) -> None:
        workflow = load_workflow("calendar-reconciliation.json")
        nodes = {node["name"]: node for node in workflow["nodes"]}
        serialized = json.dumps(workflow)

        self.assertEqual(nodes["Nightly Reconciliation"]["type"], "n8n-nodes-base.scheduleTrigger")
        self.assertIn("/internal/calendar/reconciliation/claim", serialized)
        self.assertIn("/internal/calendar/provider/changes", serialized)
        self.assertIn("/internal/calendar/provider/watch", serialized)
        self.assertIn("/internal/calendar/watch/renew", serialized)
        self.assertIn("/internal/calendar/sync/apply", serialized)
        self.assertNotIn("googleOAuth2Api", serialized)
        self.assertNotIn("attendees", serialized)
        self.assertNotIn("conferenceData", serialized)


if __name__ == "__main__":
    unittest.main()
