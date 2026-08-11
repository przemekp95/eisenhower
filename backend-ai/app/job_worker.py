from __future__ import annotations

from datetime import datetime
import random
from threading import Event, Thread
from typing import Callable

from .jobs import Job, SqliteJobQueue


class PermanentJobError(ValueError):
  """A validated command cannot succeed if retried unchanged."""


JobHandler = Callable[[dict], None]


class JobWorker:
  def __init__(
    self,
    queue: SqliteJobQueue,
    handlers: dict[str, JobHandler],
    *,
    max_attempts: int = 5,
    base_backoff_seconds: float = 2.0,
    max_backoff_seconds: float = 300.0,
    lease_seconds: int = 300,
    lease_renewal_seconds: float = 30.0,
    random_value: Callable[[], float] = random.random,
  ):
    retry_limits = (max_attempts, base_backoff_seconds, max_backoff_seconds)
    if any(value <= 0 for value in retry_limits):
      raise ValueError("Worker retry limits must be positive")
    if lease_seconds < 1 or not 0 < lease_renewal_seconds < lease_seconds:
      raise ValueError("Worker lease renewal must be positive and shorter than the lease")
    self.queue = queue
    self.handlers = dict(handlers)
    self.max_attempts = max_attempts
    self.base_backoff_seconds = base_backoff_seconds
    self.max_backoff_seconds = max_backoff_seconds
    self.lease_seconds = lease_seconds
    self.lease_renewal_seconds = lease_renewal_seconds
    self.random_value = random_value

  def run_once(self, *, worker_id: str, now: datetime | None = None) -> bool:
    job = self.queue.claim_next(worker_id, now=now, lease_seconds=self.lease_seconds)
    if job is None:
      return False
    renewal_stopped = Event()
    renewal_error: list[Exception] = []
    self.queue.record_worker_heartbeat(worker_id)

    def renew_lease() -> None:
      while not renewal_stopped.wait(self.lease_renewal_seconds):
        try:
          self.queue.renew_lease(job.job_id, worker_id, lease_seconds=self.lease_seconds)
          self.queue.record_worker_heartbeat(worker_id)
        except Exception as error:  # Preserve the handler result but never acknowledge a lost lease.
          renewal_error.append(error)
          return

    renewal_thread = Thread(target=renew_lease, name=f"lease-{job.job_id}", daemon=True)
    renewal_thread.start()
    try:
      handler = self.handlers.get(job.job_type)
      if handler is None:
        raise PermanentJobError("No allowlisted handler is registered")
      handler(job.payload)
    except Exception as error:
      renewal_stopped.set()
      renewal_thread.join()
      self._record_failure(job, worker_id, error, now=now)
    else:
      renewal_stopped.set()
      renewal_thread.join()
      if renewal_error:
        raise RuntimeError("Job lease renewal failed; refusing to acknowledge the handler") from renewal_error[0]
      self.queue.complete(job.job_id, worker_id, now=now)
    return True

  def _record_failure(
    self,
    job: Job,
    worker_id: str,
    error: Exception,
    *,
    now: datetime | None,
  ) -> None:
    permanent = isinstance(error, PermanentJobError)
    exhausted = job.attempts >= self.max_attempts
    exponential = min(
      self.max_backoff_seconds,
      self.base_backoff_seconds * (2 ** max(0, job.attempts - 1)),
    )
    jittered = exponential * (0.75 + (self.random_value() * 0.5))
    self.queue.fail(
      job.job_id,
      worker_id,
      error_code=type(error).__name__,
      retry_after_seconds=0 if permanent or exhausted else jittered,
      dead_letter=permanent or exhausted,
      now=now,
    )
