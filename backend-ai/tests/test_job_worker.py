from datetime import datetime, timedelta, timezone

from app.job_worker import JobWorker, PermanentJobError
from app.jobs import SqliteJobQueue


def test_worker_claims_completes_and_does_not_repeat(tmp_path):
  queue = SqliteJobQueue(tmp_path / "jobs.sqlite3")
  queued = queue.enqueue("event-1", "rag.upsert", {"value": 7})
  seen = []
  worker = JobWorker(queue, {"rag.upsert": lambda payload: seen.append(payload["value"])})

  assert worker.run_once(worker_id="worker-a") is True
  assert seen == [7]
  assert queue.get(queued.job_id).status == "completed"
  assert queue.get(queued.job_id).attempts == 1
  assert worker.run_once(worker_id="worker-a") is False


def test_worker_retries_then_dead_letters_with_bounded_backoff(tmp_path):
  queue = SqliteJobQueue(tmp_path / "jobs.sqlite3")
  queued = queue.enqueue("event-2", "rag.upsert", {})
  now = datetime.now(timezone.utc)

  def fail(_payload):
    raise RuntimeError("sensitive upstream failure")

  worker = JobWorker(
    queue,
    {"rag.upsert": fail},
    max_attempts=2,
    base_backoff_seconds=4,
    random_value=lambda: 0.5,
  )

  assert worker.run_once(worker_id="worker-a", now=now) is True
  retry = queue.get(queued.job_id)
  assert retry.status == "queued"
  assert retry.last_error == "RuntimeError"
  assert datetime.fromisoformat(retry.available_at) == now + timedelta(seconds=4)

  assert worker.run_once(worker_id="worker-a", now=now + timedelta(seconds=4)) is True
  dead = queue.get(queued.job_id)
  assert dead.status == "dead_letter"
  assert dead.attempts == 2


def test_permanent_failure_is_dead_lettered_without_retry(tmp_path):
  queue = SqliteJobQueue(tmp_path / "jobs.sqlite3")
  queued = queue.enqueue("event-3", "rag.evaluate", {})

  def reject(_payload):
    raise PermanentJobError("invalid immutable dataset")

  worker = JobWorker(queue, {"rag.evaluate": reject})
  worker.run_once(worker_id="worker-a")

  assert queue.get(queued.job_id).status == "dead_letter"
  assert queue.get(queued.job_id).attempts == 1


def test_expired_worker_lease_can_be_reclaimed(tmp_path):
  queue = SqliteJobQueue(tmp_path / "jobs.sqlite3")
  queued = queue.enqueue("event-4", "rag.tombstone", {})
  now = datetime.now(timezone.utc)

  first = queue.claim_next("worker-a", now=now, lease_seconds=10)
  assert first.job_id == queued.job_id
  assert queue.claim_next("worker-b", now=now + timedelta(seconds=9)) is None

  reclaimed = queue.claim_next("worker-b", now=now + timedelta(seconds=11))
  assert reclaimed.job_id == queued.job_id
  assert reclaimed.attempts == 2
