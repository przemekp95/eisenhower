from __future__ import annotations

from collections import defaultdict, deque
from threading import Lock
from time import monotonic
from typing import Callable


class SlidingWindowRateLimiter:
  """Per-process safety limit; production edge limits remain authoritative."""

  def __init__(
    self,
    *,
    limit: int,
    window_seconds: float,
    clock: Callable[[], float] = monotonic,
  ):
    if limit < 1 or window_seconds <= 0:
      raise ValueError("Rate-limit values must be positive")
    self.limit = limit
    self.window_seconds = window_seconds
    self.clock = clock
    self._events: dict[str, deque[float]] = defaultdict(deque)
    self._lock = Lock()

  def allow(self, key: str) -> bool:
    now = self.clock()
    cutoff = now - self.window_seconds
    with self._lock:
      events = self._events[key]
      while events and events[0] <= cutoff:
        events.popleft()
      if len(events) >= self.limit:
        return False
      events.append(now)
      return True
