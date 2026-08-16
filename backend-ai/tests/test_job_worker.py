from datetime import datetime, timedelta, timezone
import sqlite3
from threading import Event, Thread
from time import sleep

import pytest

from app.job_worker import JobWorker, PermanentJobError
from app.jobs import JobConflictError, SqliteJobQueue


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


def test_long_handler_renews_lease_so_second_worker_cannot_duplicate_it(tmp_path):
  queue = SqliteJobQueue(tmp_path / "jobs.sqlite3")
  queued = queue.enqueue("event-long", "rag.upsert", {})
  entered = Event()
  release = Event()
  calls = []

  def slow_handler(_payload):
    calls.append("worker-a")
    entered.set()
    assert release.wait(3)

  worker = JobWorker(
    queue,
    {"rag.upsert": slow_handler},
    lease_seconds=1,
    lease_renewal_seconds=0.1,
  )
  thread = Thread(target=lambda: worker.run_once(worker_id="worker-a"), daemon=True)
  thread.start()
  assert entered.wait(1)
  sleep(1.2)

  assert queue.claim_next("worker-b", lease_seconds=1) is None
  heartbeat_age = queue.latest_worker_heartbeat_age_seconds()
  assert heartbeat_age is not None
  assert heartbeat_age < 0.5
  release.set()
  thread.join(timeout=2)

  assert calls == ["worker-a"]
  assert queue.get(queued.job_id).status == "completed"


def test_lease_renewal_and_worker_heartbeat_are_owned_and_observable(tmp_path):
  queue = SqliteJobQueue(tmp_path / "jobs.sqlite3")
  queued = queue.enqueue("event-heartbeat", "rag.upsert", {})
  now = datetime.now(timezone.utc)
  queue.claim_next("worker-a", now=now, lease_seconds=10)

  queue.renew_lease(queued.job_id, "worker-a", now=now + timedelta(seconds=5), lease_seconds=10)
  with pytest.raises(RuntimeError, match="no longer owned"):
    queue.renew_lease(queued.job_id, "worker-b", now=now + timedelta(seconds=6))

  queue.record_worker_heartbeat("worker-a", now=now)
  assert queue.latest_worker_heartbeat_age_seconds(now=now + timedelta(seconds=7)) == 7


def test_terminal_job_and_stale_heartbeat_cleanup_is_bounded_and_retry_safe(tmp_path):
  path = tmp_path / "jobs.sqlite3"
  queue = SqliteJobQueue(path)
  now = datetime.now(timezone.utc) + timedelta(hours=1)
  completed = []
  for sequence in range(3):
    job = queue.enqueue(f"completed-{sequence}", "rag.upsert", {})
    queue.claim_next("worker-a", now=now + timedelta(seconds=sequence))
    queue.complete(job.job_id, "worker-a", now=now + timedelta(seconds=sequence))
    completed.append(job.job_id)
  retry = queue.enqueue("retry", "rag.upsert", {})
  queue.claim_next("worker-a", now=now + timedelta(seconds=4))
  queue.fail(
    retry.job_id,
    "worker-a",
    error_code="RuntimeError",
    retry_after_seconds=60,
    dead_letter=False,
    now=now + timedelta(seconds=4),
  )
  running = queue.enqueue("running", "rag.upsert", {})
  queue.claim_next("worker-a", now=now + timedelta(seconds=5))
  queue.record_worker_heartbeat("stale-a", now=now)
  queue.record_worker_heartbeat("stale-b", now=now + timedelta(seconds=1))
  queue.record_worker_heartbeat("current", now=now + timedelta(hours=2))

  assert queue.prune_terminal_jobs(before=now + timedelta(minutes=1), limit=2) == 2
  assert sum(queue.get(job_id) is not None for job_id in completed) == 1
  replay = queue.enqueue("completed-0", "rag.upsert", {})
  assert replay.status == "completed"
  assert queue.get(replay.job_id) is None
  with pytest.raises(JobConflictError, match="already bound"):
    queue.enqueue("completed-0", "rag.upsert", {"changed": True})
  assert queue.get(retry.job_id).status == "queued"
  assert queue.get(running.job_id).status == "running"
  assert queue.prune_stale_worker_heartbeats(
    before=now + timedelta(minutes=1), limit=1
  ) == 1

  with sqlite3.connect(path) as connection:
    remaining_heartbeats = connection.execute(
      "SELECT worker_id FROM worker_heartbeats ORDER BY worker_id"
    ).fetchall()
    terminal_plan = connection.execute(
      "EXPLAIN QUERY PLAN SELECT job_id FROM jobs "
      "WHERE status IN ('completed', 'dead_letter') AND updated_at < ? "
      "ORDER BY updated_at, job_id LIMIT 10",
      ((now + timedelta(minutes=1)).isoformat(),),
    ).fetchall()
    heartbeat_plan = connection.execute(
      "EXPLAIN QUERY PLAN SELECT worker_id FROM worker_heartbeats "
      "WHERE updated_at < ? ORDER BY updated_at, worker_id LIMIT 10",
      ((now + timedelta(minutes=1)).isoformat(),),
    ).fetchall()

  assert remaining_heartbeats == [("current",), ("stale-b",)]
  assert "jobs_terminal_cleanup_idx" in " ".join(str(row) for row in terminal_plan)
  assert "worker_heartbeats_cleanup_idx" in " ".join(str(row) for row in heartbeat_plan)


def test_claim_query_uses_indexes_for_queued_and_expired_running_jobs(tmp_path):
  path = tmp_path / "jobs.sqlite3"
  SqliteJobQueue(path)
  now = datetime.now(timezone.utc).isoformat()

  with sqlite3.connect(path) as connection:
    plan = connection.execute(
      "EXPLAIN QUERY PLAN "
      "SELECT job_id, created_at FROM ("
      "SELECT job_id, created_at FROM jobs WHERE status = 'queued' AND available_at <= ? "
      "UNION ALL "
      "SELECT job_id, created_at FROM jobs WHERE status = 'running' AND lease_expires_at <= ?"
      ") ORDER BY created_at, job_id LIMIT 1",
      (now, now),
    ).fetchall()

  rendered = " ".join(str(row) for row in plan)
  assert "jobs_queued_claim_idx" in rendered
  assert "jobs_running_claim_idx" in rendered
