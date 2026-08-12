from datetime import datetime, timezone
import json

import pytest

from app.jobs import JobConflictError, SqliteJobQueue
from app.webhooks import (
  WEBHOOK_INGRESS_METHOD,
  WEBHOOK_INGRESS_PATH,
  WEBHOOK_SIGNATURE_VERSION,
  WebhookReplayVerifier,
  parse_webhook_envelope,
)


def test_sqlite_job_queue_is_durable_and_idempotent(tmp_path):
  path = tmp_path / "jobs.sqlite3"
  first = SqliteJobQueue(path)

  created = first.enqueue("event-1", "rag.upsert", {"tenant_id": "tenant-a"})
  duplicate = first.enqueue("event-1", "rag.upsert", {"tenant_id": "tenant-a"})
  reopened = SqliteJobQueue(path)

  assert created.job_id == duplicate.job_id
  assert reopened.get(created.job_id).status == "queued"


def test_sqlite_job_queue_treats_canonical_payload_as_the_idempotent_request(tmp_path):
  queue = SqliteJobQueue(tmp_path / "jobs.sqlite3")

  created = queue.enqueue(
    "event-1",
    "rag.upsert",
    {"tenant_id": "tenant-a", "documents": [{"id": "doc-1", "title": "One"}]},
  )
  replay = queue.enqueue(
    "event-1",
    "rag.upsert",
    {"documents": [{"title": "One", "id": "doc-1"}], "tenant_id": "tenant-a"},
  )

  assert replay == created


@pytest.mark.parametrize(
  ("job_type", "payload"),
  [
    ("rag.upsert", {"tenant_id": "tenant-b"}),
    ("rag.tombstone", {"tenant_id": "tenant-a"}),
  ],
)
def test_sqlite_job_queue_rejects_idempotency_key_reuse_for_a_different_request(
  tmp_path,
  job_type,
  payload,
):
  queue = SqliteJobQueue(tmp_path / "jobs.sqlite3")
  original = queue.enqueue("event-1", "rag.upsert", {"tenant_id": "tenant-a"})

  with pytest.raises(JobConflictError, match="already bound"):
    queue.enqueue("event-1", job_type, payload)

  assert queue.get(original.job_id) == original


def test_webhook_verifier_checks_exact_raw_bytes_context_window_and_replay(tmp_path):
  secret = "test-webhook-secret"
  verifier = WebhookReplayVerifier(tmp_path / "replay.sqlite3", secret=secret, window_seconds=300)
  timestamp = str(int(datetime.now(timezone.utc).timestamp()))
  raw_body = b'{\n  "event_id": "event-1",\n  "operation": "upsert"\n}'
  signature = verifier.sign_webhook(timestamp, raw_body)
  context = {
    "method": WEBHOOK_INGRESS_METHOD,
    "path": WEBHOOK_INGRESS_PATH,
    "version": WEBHOOK_SIGNATURE_VERSION,
  }

  assert verifier.verify(timestamp, signature, "event-1", raw_body, **context) is True
  assert verifier.verify(timestamp, signature, "event-1", raw_body, **context) is False
  assert verifier.verify(timestamp, signature, "event-2", raw_body.replace(b"  ", b" "), **context) is False
  assert verifier.verify(timestamp, "0" * 64, "event-3", raw_body, **context) is False
  assert verifier.verify(timestamp, signature, "event-4", raw_body, **{**context, "method": "PUT"}) is False
  assert verifier.verify(timestamp, signature, "event-5", raw_body, **{**context, "path": "/other"}) is False
  assert verifier.verify(timestamp, signature, "event-6", raw_body, **{**context, "version": "v2"}) is False


def test_webhook_replay_records_outlive_the_signature_window(tmp_path):
  now = [1_800_000_000]
  verifier = WebhookReplayVerifier(
    tmp_path / "replay.sqlite3",
    secret="test-webhook-secret",
    window_seconds=300,
    replay_retention_seconds=3600,
    clock=lambda: now[0],
  )
  raw_body = b'{"event_id":"event-1"}'
  context = {
    "method": WEBHOOK_INGRESS_METHOD,
    "path": WEBHOOK_INGRESS_PATH,
    "version": WEBHOOK_SIGNATURE_VERSION,
  }
  first_timestamp = str(now[0])
  first_signature = verifier.sign_webhook(first_timestamp, raw_body)

  assert verifier.verify(first_timestamp, first_signature, "event-1", raw_body, **context) is True
  now[0] += 301
  retry_timestamp = str(now[0])
  retry_signature = verifier.sign_webhook(retry_timestamp, raw_body)

  assert verifier.verify(retry_timestamp, retry_signature, "event-1", raw_body, **context) is False


def test_webhook_parser_rejects_duplicate_non_finite_and_extra_fields():
  with pytest.raises(ValueError, match="Duplicate JSON field"):
    parse_webhook_envelope(b'{"schema_version":"2","schema_version":"2"}')

  with pytest.raises(ValueError, match="Non-finite JSON number"):
    parse_webhook_envelope(b'{"source_sequence":NaN}')

  with pytest.raises(ValueError, match="Extra inputs are not permitted"):
    parse_webhook_envelope(
      b'{"schema_version":"2","event_id":"00000000-0000-4000-8000-000000000001",'
      b'"operation":"reindex_project","tenant_id":"tenant-a","project_id":"project-a",'
      b'"source_version":"v1","source_sequence":1,'
      b'"content_checksum":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
      b'"embedding_version":"minilm-v1","chunking_version":"chars-v1","unexpected":true}'
    )


@pytest.mark.parametrize(
  "operation_fields",
  [
    {"operation": "upsert", "documents": []},
    {"operation": "upsert", "documents": [{"document_id": "doc"}], "document_ids": ["doc"]},
    {"operation": "tombstone", "document_ids": []},
    {"operation": "tombstone", "document_ids": ["doc"], "dataset_version": "v1"},
    {"operation": "reindex_project", "documents": [{"document_id": "doc"}]},
    {"operation": "start_rag_evaluation", "dataset_version": "v1", "document_ids": ["doc"]},
  ],
)
def test_webhook_parser_rejects_empty_or_cross_operation_payload_fields(operation_fields):
  payload = {
    "schema_version": "2",
    "event_id": "00000000-0000-4000-8000-000000000001",
    "tenant_id": "tenant-a",
    "project_id": "project-a",
    "source_version": "v1",
    "source_sequence": 1,
    "content_checksum": f"sha256:{'a' * 64}",
    "embedding_version": "minilm-v1",
    "chunking_version": "chars-v1",
    **operation_fields,
  }

  with pytest.raises(ValueError):
    parse_webhook_envelope(json.dumps(payload).encode("utf-8"))
