from __future__ import annotations

from collections.abc import Callable
from hmac import compare_digest
from time import monotonic, sleep


class InferenceLifecycleUnauthorized(PermissionError):
  """The operator credential did not authorize a lifecycle transition."""


class InferenceWakeTimeout(RuntimeError):
  """The stopped inference runtime did not become ready before its deadline."""


class ScaleToZeroController:
  """Narrow orchestration boundary for a private stopped/running inference service.

  vLLM development-mode sleep endpoints are intentionally outside this boundary.
  The injected operations are owned by the local orchestrator (Compose/systemd),
  while readiness must use the authenticated stable `/v1` surface.
  """

  def __init__(
    self,
    *,
    operator_token: str,
    start: Callable[[], None],
    stop: Callable[[], None],
    is_ready: Callable[[], bool],
    wake_timeout_seconds: float,
    poll_interval_seconds: float = 1.0,
    monotonic_clock: Callable[[], float] = monotonic,
    sleeper: Callable[[float], None] = sleep,
  ):
    if not operator_token:
      raise ValueError("A lifecycle operator token is required")
    if wake_timeout_seconds <= 0 or poll_interval_seconds < 0:
      raise ValueError("Lifecycle timeout values must be bounded and non-negative")
    self._operator_token = operator_token
    self._start = start
    self._stop = stop
    self._is_ready = is_ready
    self._wake_timeout_seconds = wake_timeout_seconds
    self._poll_interval_seconds = poll_interval_seconds
    self._monotonic = monotonic_clock
    self._sleep = sleeper

  def sleep(self, presented_token: str) -> None:
    self._authorize(presented_token)
    self._stop()

  def wake(self, presented_token: str) -> None:
    self._authorize(presented_token)
    started_at = self._monotonic()
    self._start()
    while True:
      if self._is_ready():
        return
      if self._monotonic() - started_at >= self._wake_timeout_seconds:
        self._stop()
        raise InferenceWakeTimeout(
          "Inference cold-wake timed out; the partial runtime was stopped fail-closed."
        )
      self._sleep(self._poll_interval_seconds)

  def _authorize(self, presented_token: str) -> None:
    if not compare_digest(self._operator_token, presented_token):
      raise InferenceLifecycleUnauthorized("Inference lifecycle operation is not authorized")
