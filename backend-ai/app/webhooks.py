from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
import hmac
import json
from pathlib import Path
import sqlite3


class WebhookReplayVerifier:
  def __init__(self, path: Path, *, secret: str, window_seconds: int = 300):
    if not secret:
      raise ValueError("Webhook signing secret is required")
    self.path = path
    self.secret = secret.encode("utf-8")
    self.window_seconds = window_seconds
    self.path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(self.path) as connection:
      connection.execute(
        "CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, accepted_at INTEGER NOT NULL)"
      )

  def verify(self, timestamp: str, signature: str, event_id: str, body: dict) -> bool:
    try:
      received_at = int(timestamp)
    except (TypeError, ValueError):
      return False
    now = int(datetime.now(timezone.utc).timestamp())
    if abs(now - received_at) > self.window_seconds:
      return False
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    expected = hmac.new(
      self.secret,
      timestamp.encode("utf-8") + b"." + canonical,
      sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
      return False
    try:
      with sqlite3.connect(self.path, timeout=5) as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
          "INSERT INTO webhook_events (event_id, accepted_at) VALUES (?, ?)",
          (event_id, now),
        )
      return True
    except sqlite3.IntegrityError:
      return False

  def sign_internal_dispatch(self, event_id: str, tenant_id: str, operation: str) -> str:
    message = f"{event_id}|{tenant_id}|{operation}".encode("utf-8")
    return hmac.new(self.secret, message, sha256).hexdigest()

  def verify_internal_dispatch(
    self,
    signature: str,
    event_id: str,
    tenant_id: str,
    operation: str,
  ) -> bool:
    expected = self.sign_internal_dispatch(event_id, tenant_id, operation)
    return hmac.compare_digest(signature, expected)
