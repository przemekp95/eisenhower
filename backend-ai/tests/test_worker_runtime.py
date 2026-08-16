from datetime import datetime, timedelta, timezone

from app.worker_runtime import _maintain_queue


class RecordingQueue:
  def __init__(self):
    self.calls = []

  def prune_terminal_jobs(self, *, before, limit):
    self.calls.append(("terminal", before, limit))

  def prune_stale_worker_heartbeats(self, *, before, limit):
    self.calls.append(("heartbeat", before, limit))


def test_worker_maintenance_applies_bounded_retention_windows():
  queue = RecordingQueue()
  now = datetime(2026, 8, 16, 12, tzinfo=timezone.utc)

  _maintain_queue(queue, now=now)

  assert queue.calls == [
    ("terminal", now - timedelta(days=7), 1000),
    ("heartbeat", now - timedelta(days=1), 1000),
  ]
