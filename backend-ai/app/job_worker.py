from __future__ import annotations

from datetime import datetime
import random
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
    random_value: Callable[[], float] = random.random,
  ):
    if max_attempts < 1 or base_backoff_seconds <= 0 or max_backoff_seconds <= 0:
      raise ValueError("Worker retry limits must be positive")
    self.queue = queue
    self.handlers = dict(handlers)
    self.max_attempts = max_attempts
    self.base_backoff_seconds = base_backoff_seconds
    self.max_backoff_seconds = max_backoff_seconds
    self.random_value = random_value

  def run_once(self, *, worker_id: str, now: datetime | None = None) -> bool:
    job = self.queue.claim_next(worker_id, now=now)
    if job is None:
      return False
    try:
      handler = self.handlers.get(job.job_type)
      if handler is None:
        raise PermanentJobError("No allowlisted handler is registered")
      handler(job.payload)
    except Exception as error:
      self._record_failure(job, worker_id, error, now=now)
    else:
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
