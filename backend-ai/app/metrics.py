from __future__ import annotations

from collections import Counter
from threading import Lock
import re


RAG_MODES = {"rag", "fallback", "no_answer"}
RAG_REASONS = {
  "none",
  "no_retrieval_hits",
  "generation_disabled",
  "generation_unavailable",
  "generation_timeout",
  "generation_connection_error",
  "generation_rate_limited",
  "generation_server_error",
  "generation_circuit_open",
  "invalid_generation_output",
  "invalid_citations",
  "invalid_information_delta",
  "current_world_freshness_unverified",
  "rag_disabled",
  "rag_response_disabled",
  "tenant_not_enabled",
  "user_not_enabled",
  "vllm_timeout",
}
RETRIEVAL_STAGES = {"shadow", "search", "online", "evaluation"}
VALIDATION_KINDS = {"schema", "citations", "grounding", "information_delta"}
VALIDATION_OUTCOMES = {"accepted", "rejected"}
GENERATION_OUTCOMES = {"success", "no_answer", "unavailable", "rejected"}
GENERATION_CIRCUIT_STATES = {"disabled", "closed", "open", "half_open", "unknown"}
MEMORY_OPERATIONS = {"create", "supersede", "revoke", "delete", "search", "reconcile", "export"}
MEMORY_OUTCOMES = {"success", "conflict", "rejected", "error", "no_hit"}
INFORMATION_DELTA_STATUSES = {
  "new_information",
  "mixed",
  "confirmation_only",
  "no_new_information",
  "freshness_unverified",
}
AUDIT_OUTCOMES = {"attempt", "success", "rejected", "error"}
RELEASE_SHA_PATTERN = re.compile(r"^[a-f0-9]{40}$")
LATENCY_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0)


def _bounded(value: str, allowed: set[str]) -> str:
  return value if value in allowed else "other"


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
    self._rag_retrieval_duration_count = Counter()
    self._rag_retrieval_duration_sum = Counter()
    self._rag_retrieval_duration_buckets = Counter()
    self._rag_retrieved_chunks_count = Counter()
    self._rag_retrieved_chunks_sum = Counter()
    self._rag_analysis_duration_count = Counter()
    self._rag_analysis_duration_sum = Counter()
    self._rag_analysis_duration_buckets = Counter()
    self._rag_input_tokens_count = Counter()
    self._rag_input_tokens_sum = Counter()
    self._rag_validation = Counter()
    self._rag_generation = Counter()
    self._rag_generation_duration_count = Counter()
    self._rag_generation_duration_sum = Counter()
    self._rag_generation_duration_buckets = Counter()
    self._information_delta = Counter()
    self._generation_circuit_state = "disabled"
    self._generation_circuit_failures = 0
    self._memory = Counter()
    self._memory_duration_count = Counter()
    self._memory_duration_sum = Counter()
    self._memory_duration_buckets = Counter()
    self._job_depth: dict[str, int] = {}
    self._job_queue_enabled = False
    self._job_worker_heartbeat_age_seconds: float | None = None
    self._release_sha = "0" * 40
    self._audit = Counter()

  def set_release_sha(self, release_sha: str) -> None:
    if RELEASE_SHA_PATTERN.fullmatch(release_sha) is None:
      raise ValueError("release_sha must be a lowercase 40-character Git commit")
    with self._lock:
      self._release_sha = release_sha

  def observe_audit(self, outcome: str) -> None:
    with self._lock:
      self._audit[_bounded(outcome, AUDIT_OUTCOMES)] += 1

  def observe_http(self, method: str, route: str, status: int, duration_seconds: float) -> None:
    key = (method.upper(), route, str(status))
    duration_key = (method.upper(), route)
    with self._lock:
      self._http[key] += 1
      self._http_duration_count[duration_key] += 1
      self._http_duration_sum[duration_key] += max(0.0, duration_seconds)

  def observe_rag_result(self, mode: str, reason: str | None = None) -> None:
    bounded_mode = _bounded(mode, RAG_MODES)
    bounded_reason = _bounded(reason or "none", RAG_REASONS)
    with self._lock:
      self._rag[(bounded_mode, bounded_reason)] += 1

  def observe_rag_retrieval(
    self,
    stage: str,
    *,
    hit_count: int | None,
    duration_seconds: float = 0.0,
  ) -> None:
    bounded_stage = _bounded(stage, RETRIEVAL_STAGES)
    outcome = "error" if hit_count is None else ("hit" if hit_count > 0 else "no_hit")
    with self._lock:
      self._rag_retrieval[(bounded_stage, outcome)] += 1
      self._rag_retrieval_duration_count[(bounded_stage, outcome)] += 1
      self._rag_retrieval_duration_sum[(bounded_stage, outcome)] += max(0.0, duration_seconds)
      self._observe_latency_buckets(
        self._rag_retrieval_duration_buckets,
        (bounded_stage, outcome),
        duration_seconds,
      )
      if hit_count is not None:
        self._rag_retrieved_chunks_count[bounded_stage] += 1
        self._rag_retrieved_chunks_sum[bounded_stage] += max(0, int(hit_count))

  def observe_rag_analysis(self, mode: str, *, duration_seconds: float) -> None:
    bounded_mode = _bounded(mode, RAG_MODES)
    with self._lock:
      self._rag_analysis_duration_count[bounded_mode] += 1
      self._rag_analysis_duration_sum[bounded_mode] += max(0.0, duration_seconds)
      self._observe_latency_buckets(
        self._rag_analysis_duration_buckets,
        (bounded_mode,),
        duration_seconds,
      )

  def observe_rag_validation(self, kind: str, outcome: str) -> None:
    key = (_bounded(kind, VALIDATION_KINDS), _bounded(outcome, VALIDATION_OUTCOMES))
    with self._lock:
      self._rag_validation[key] += 1

  def observe_generation(self, outcome: str, *, duration_seconds: float, input_tokens: int) -> None:
    bounded_outcome = _bounded(outcome, GENERATION_OUTCOMES)
    with self._lock:
      self._rag_generation[bounded_outcome] += 1
      self._rag_generation_duration_count[bounded_outcome] += 1
      self._rag_generation_duration_sum[bounded_outcome] += max(0.0, duration_seconds)
      self._observe_latency_buckets(
        self._rag_generation_duration_buckets,
        (bounded_outcome,),
        duration_seconds,
      )
      self._rag_input_tokens_count[bounded_outcome] += 1
      self._rag_input_tokens_sum[bounded_outcome] += max(0, int(input_tokens))

  def observe_information_delta(self, status: str) -> None:
    bounded_status = _bounded(status, INFORMATION_DELTA_STATUSES)
    with self._lock:
      self._information_delta[bounded_status] += 1

  def observe_memory(self, operation: str, outcome: str, *, duration_seconds: float) -> None:
    key = (
      _bounded(operation, MEMORY_OPERATIONS),
      _bounded(outcome, MEMORY_OUTCOMES),
    )
    with self._lock:
      self._memory[key] += 1
      self._memory_duration_count[key] += 1
      self._memory_duration_sum[key] += max(0.0, duration_seconds)
      self._observe_latency_buckets(self._memory_duration_buckets, key, duration_seconds)

  @staticmethod
  def _observe_latency_buckets(counter: Counter, key: tuple[str, ...], duration_seconds: float) -> None:
    value = max(0.0, duration_seconds)
    for bucket in LATENCY_BUCKETS:
      if value <= bucket:
        counter[(*key, bucket)] += 1
    counter[(*key, float("inf"))] += 1

  def set_job_depth(self, status: str, count: int) -> None:
    with self._lock:
      self._job_depth[status] = max(0, int(count))

  def set_job_queue_enabled(self, enabled: bool) -> None:
    with self._lock:
      self._job_queue_enabled = bool(enabled)

  def set_job_worker_heartbeat_age(self, age_seconds: float | None) -> None:
    with self._lock:
      self._job_worker_heartbeat_age_seconds = (
        None if age_seconds is None else max(0.0, float(age_seconds))
      )

  def set_generation_status(self, state: str, *, failures: int) -> None:
    with self._lock:
      self._generation_circuit_state = _bounded(state, GENERATION_CIRCUIT_STATES)
      self._generation_circuit_failures = max(0, int(failures))

  def render(self) -> str:
    with self._lock:
      lines = [
        "# HELP eisenhower_release_info Exact source revision exposed by this process.",
        "# TYPE eisenhower_release_info gauge",
        f"eisenhower_release_info{{{_labels(sha=self._release_sha)}}} 1",
        "# HELP eisenhower_audit_events_total Privacy-safe durable audit outcomes.",
        "# TYPE eisenhower_audit_events_total counter",
        "# HELP eisenhower_http_requests_total HTTP requests by stable route and status.",
        "# TYPE eisenhower_http_requests_total counter",
      ]
      for outcome, value in sorted(self._audit.items()):
        lines.append(
          f"eisenhower_audit_events_total{{{_labels(outcome=outcome)}}} {value}"
        )
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
        "# HELP eisenhower_rag_retrieval_duration_seconds Retrieval duration summary by bounded stage and outcome.",
        "# TYPE eisenhower_rag_retrieval_duration_seconds histogram",
      ])
      for key, value in sorted(self._rag_retrieval_duration_count.items()):
        stage, outcome = key
        for bucket in (*LATENCY_BUCKETS, float("inf")):
          bucket_label = "+Inf" if bucket == float("inf") else f"{bucket:.3f}"
          labels = _labels(stage=stage, outcome=outcome, le=bucket_label)
          lines.append(
            f"eisenhower_rag_retrieval_duration_seconds_bucket{{{labels}}} "
            f"{self._rag_retrieval_duration_buckets[(*key, bucket)]}"
          )
        labels = _labels(stage=stage, outcome=outcome)
        lines.append(f"eisenhower_rag_retrieval_duration_seconds_count{{{labels}}} {value}")
        lines.append(
          f"eisenhower_rag_retrieval_duration_seconds_sum{{{labels}}} "
          f"{self._rag_retrieval_duration_sum[key]:.6f}"
        )
      lines.extend([
        "# HELP eisenhower_rag_retrieved_chunks Retrieved chunk count summary without content labels.",
        "# TYPE eisenhower_rag_retrieved_chunks summary",
      ])
      for stage, value in sorted(self._rag_retrieved_chunks_count.items()):
        labels = _labels(stage=stage)
        lines.append(f"eisenhower_rag_retrieved_chunks_count{{{labels}}} {value}")
        lines.append(
          f"eisenhower_rag_retrieved_chunks_sum{{{labels}}} "
          f"{self._rag_retrieved_chunks_sum[stage]}"
        )
      lines.extend([
        "# HELP eisenhower_rag_analysis_duration_seconds End-to-end RAG analysis duration summary.",
        "# TYPE eisenhower_rag_analysis_duration_seconds histogram",
      ])
      for mode, value in sorted(self._rag_analysis_duration_count.items()):
        for bucket in (*LATENCY_BUCKETS, float("inf")):
          bucket_label = "+Inf" if bucket == float("inf") else f"{bucket:.3f}"
          labels = _labels(mode=mode, le=bucket_label)
          lines.append(
            f"eisenhower_rag_analysis_duration_seconds_bucket{{{labels}}} "
            f"{self._rag_analysis_duration_buckets[(mode, bucket)]}"
          )
        labels = _labels(mode=mode)
        lines.append(f"eisenhower_rag_analysis_duration_seconds_count{{{labels}}} {value}")
        lines.append(
          f"eisenhower_rag_analysis_duration_seconds_sum{{{labels}}} "
          f"{self._rag_analysis_duration_sum[mode]:.6f}"
        )
      lines.extend([
        "# HELP eisenhower_rag_input_tokens Input token count summary by bounded outcome.",
        "# TYPE eisenhower_rag_input_tokens summary",
      ])
      for outcome, value in sorted(self._rag_input_tokens_count.items()):
        labels = _labels(outcome=outcome)
        lines.append(f"eisenhower_rag_input_tokens_count{{{labels}}} {value}")
        lines.append(f"eisenhower_rag_input_tokens_sum{{{labels}}} {self._rag_input_tokens_sum[outcome]}")
      lines.extend([
        "# HELP eisenhower_rag_validation_total Structured generation validation outcomes.",
        "# TYPE eisenhower_rag_validation_total counter",
      ])
      for (kind, outcome), value in sorted(self._rag_validation.items()):
        lines.append(
          f"eisenhower_rag_validation_total{{{_labels(kind=kind, outcome=outcome)}}} {value}"
        )
      lines.extend([
        "# HELP eisenhower_information_delta_total Validated source-relative delta outcomes.",
        "# TYPE eisenhower_information_delta_total counter",
      ])
      for status, value in sorted(self._information_delta.items()):
        lines.append(
          f"eisenhower_information_delta_total{{{_labels(status=status)}}} {value}"
        )
      lines.extend([
        "# HELP eisenhower_rag_generation_total Private generation outcomes.",
        "# TYPE eisenhower_rag_generation_total counter",
        "# HELP eisenhower_rag_generation_duration_seconds Generation-path duration including retrieval.",
        "# TYPE eisenhower_rag_generation_duration_seconds histogram",
      ])
      for outcome, value in sorted(self._rag_generation.items()):
        labels = _labels(outcome=outcome)
        lines.append(f"eisenhower_rag_generation_total{{{labels}}} {value}")
        for bucket in (*LATENCY_BUCKETS, float("inf")):
          bucket_label = "+Inf" if bucket == float("inf") else f"{bucket:.3f}"
          bucket_labels = _labels(outcome=outcome, le=bucket_label)
          lines.append(
            f"eisenhower_rag_generation_duration_seconds_bucket{{{bucket_labels}}} "
            f"{self._rag_generation_duration_buckets[(outcome, bucket)]}"
          )
        lines.append(
          f"eisenhower_rag_generation_duration_seconds_count{{{labels}}} "
          f"{self._rag_generation_duration_count[outcome]}"
        )
        lines.append(
          f"eisenhower_rag_generation_duration_seconds_sum{{{labels}}} "
          f"{self._rag_generation_duration_sum[outcome]:.6f}"
        )
      lines.extend([
        "# HELP eisenhower_generation_circuit_state Optional inference circuit state.",
        "# TYPE eisenhower_generation_circuit_state gauge",
        f"eisenhower_generation_circuit_state{{{_labels(state=self._generation_circuit_state)}}} 1",
        "# HELP eisenhower_generation_circuit_failures Consecutive bounded provider failures.",
        "# TYPE eisenhower_generation_circuit_failures gauge",
        f"eisenhower_generation_circuit_failures {self._generation_circuit_failures}",
      ])
      lines.extend([
        "# HELP eisenhower_memory_operations_total Consent-governed memory outcomes.",
        "# TYPE eisenhower_memory_operations_total counter",
        "# HELP eisenhower_memory_operation_duration_seconds Memory operation duration summary.",
        "# TYPE eisenhower_memory_operation_duration_seconds histogram",
      ])
      for key, value in sorted(self._memory.items()):
        operation, outcome = key
        labels = _labels(operation=operation, outcome=outcome)
        lines.append(f"eisenhower_memory_operations_total{{{labels}}} {value}")
        for bucket in (*LATENCY_BUCKETS, float("inf")):
          bucket_label = "+Inf" if bucket == float("inf") else f"{bucket:.3f}"
          bucket_labels = _labels(operation=operation, outcome=outcome, le=bucket_label)
          lines.append(
            f"eisenhower_memory_operation_duration_seconds_bucket{{{bucket_labels}}} "
            f"{self._memory_duration_buckets[(*key, bucket)]}"
          )
        lines.append(
          f"eisenhower_memory_operation_duration_seconds_count{{{labels}}} "
          f"{self._memory_duration_count[key]}"
        )
        lines.append(
          f"eisenhower_memory_operation_duration_seconds_sum{{{labels}}} "
          f"{self._memory_duration_sum[key]:.6f}"
        )
      lines.extend([
        "# HELP eisenhower_job_queue_enabled Whether the durable job runtime is configured.",
        "# TYPE eisenhower_job_queue_enabled gauge",
        f"eisenhower_job_queue_enabled {int(self._job_queue_enabled)}",
        "# HELP eisenhower_job_queue_depth Durable jobs by lifecycle status.",
        "# TYPE eisenhower_job_queue_depth gauge",
      ])
      for status, value in sorted(self._job_depth.items()):
        lines.append(f"eisenhower_job_queue_depth{{{_labels(status=status)}}} {value}")
      lines.extend([
        "# HELP eisenhower_job_worker_heartbeat_age_seconds Age of the latest durable worker heartbeat.",
        "# TYPE eisenhower_job_worker_heartbeat_age_seconds gauge",
      ])
      if self._job_worker_heartbeat_age_seconds is not None:
        lines.append(
          "eisenhower_job_worker_heartbeat_age_seconds "
          f"{self._job_worker_heartbeat_age_seconds:.6f}"
        )
      return "\n".join(lines) + "\n"
