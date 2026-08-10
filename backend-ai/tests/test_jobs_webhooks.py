from datetime import datetime, timezone
from hashlib import sha256
import hmac
import json

from app.jobs import SqliteJobQueue
from app.webhooks import WebhookReplayVerifier


def test_sqlite_job_queue_is_durable_and_idempotent(tmp_path):
  path = tmp_path / "jobs.sqlite3"
  first = SqliteJobQueue(path)

  created = first.enqueue("event-1", "rag.upsert", {"tenant_id": "tenant-a"})
  duplicate = first.enqueue("event-1", "rag.upsert", {"tenant_id": "tenant-a"})
  reopened = SqliteJobQueue(path)

  assert created.job_id == duplicate.job_id
  assert reopened.get(created.job_id).status == "queued"


def test_webhook_verifier_checks_hmac_window_and_replay(tmp_path):
  secret = "test-webhook-secret"
  verifier = WebhookReplayVerifier(tmp_path / "replay.sqlite3", secret=secret, window_seconds=300)
  body = {"event_id": "event-1", "operation": "upsert"}
  timestamp = str(int(datetime.now(timezone.utc).timestamp()))
  canonical = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
  signature = hmac.new(secret.encode(), timestamp.encode() + b"." + canonical, sha256).hexdigest()

  assert verifier.verify(timestamp, signature, "event-1", body) is True
  assert verifier.verify(timestamp, signature, "event-1", body) is False
  assert verifier.verify(timestamp, "0" * 64, "event-2", body) is False
