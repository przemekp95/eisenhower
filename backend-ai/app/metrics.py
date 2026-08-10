from __future__ import annotations

from collections import Counter
from threading import Lock


def _escape(value: str) -> str:
  return str(value).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _labels(**values: str | int) -> str:
  return ",".join(f'{key}="{_escape(str(value))}"' for key, value in values.items())


class MetricsRegistry:
  """Small dependency-free Prometheus registry containing aggregate signals only."""

  def __init__(self):
    self._lock = Lock()
    self._http = Counter()
    self._http_duration_count = Counter()
    self._http_duration_sum = Counter()
    self._rag = Counter()
    self._rag_retrieval = Counter()
    self._job_depth: dict[str, int] = {}

  def observe_http(self, method: str, route: str, status: int, duration_seconds: float) -> None:
    key = (method.upper(), route, str(status))
    duration_key = (method.upper(), route)
    with self._lock:
      self._http[key] += 1
      self._http_duration_count[duration_key] += 1
      self._http_duration_sum[duration_key] += max(0.0, duration_seconds)

  def observe_rag_result(self, mode: str, reason: str | None = None) -> None:
    with self._lock:
      self._rag[(mode, reason or "none")] += 1

  def observe_rag_retrieval(self, stage: str, *, hit_count: int | None) -> None:
    outcome = "error" if hit_count is None else ("hit" if hit_count > 0 else "no_hit")
    with self._lock:
      self._rag_retrieval[(stage, outcome)] += 1

  def set_job_depth(self, status: str, count: int) -> None:
    with self._lock:
      self._job_depth[status] = max(0, int(count))

  def render(self) -> str:
    with self._lock:
      lines = [
        "# HELP eisenhower_http_requests_total HTTP requests by stable route and status.",
        "# TYPE eisenhower_http_requests_total counter",
      ]
      for (method, route, status), value in sorted(self._http.items()):
        lines.append(
          f"eisenhower_http_requests_total{{{_labels(method=method, route=route, status=status)}}} {value}"
        )
      lines.extend([
        "# HELP eisenhower_http_request_duration_seconds HTTP request duration summary.",
        "# TYPE eisenhower_http_request_duration_seconds summary",
      ])
      for (method, route), value in sorted(self._http_duration_count.items()):
        label = _labels(method=method, route=route)
        lines.append(f"eisenhower_http_request_duration_seconds_count{{{label}}} {value}")
        lines.append(
          f"eisenhower_http_request_duration_seconds_sum{{{label}}} "
          f"{self._http_duration_sum[(method, route)]:.6f}"
        )
      lines.extend([
        "# HELP eisenhower_rag_results_total RAG response modes and bounded fallback reasons.",
        "# TYPE eisenhower_rag_results_total counter",
      ])
      for (mode, reason), value in sorted(self._rag.items()):
        lines.append(
          f"eisenhower_rag_results_total{{{_labels(mode=mode, reason=reason)}}} {value}"
        )
      lines.extend([
        "# HELP eisenhower_rag_retrieval_total Aggregate retrieval outcomes by bounded stage.",
        "# TYPE eisenhower_rag_retrieval_total counter",
      ])
      for (stage, outcome), value in sorted(self._rag_retrieval.items()):
        lines.append(
          f"eisenhower_rag_retrieval_total{{{_labels(stage=stage, outcome=outcome)}}} {value}"
        )
      lines.extend([
        "# HELP eisenhower_job_queue_depth Durable jobs by lifecycle status.",
        "# TYPE eisenhower_job_queue_depth gauge",
      ])
      for status, value in sorted(self._job_depth.items()):
        lines.append(f"eisenhower_job_queue_depth{{{_labels(status=status)}}} {value}")
      return "\n".join(lines) + "\n"
