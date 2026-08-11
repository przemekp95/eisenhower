from app.metrics import MetricsRegistry


def test_prometheus_metrics_are_aggregate_and_do_not_leak_tenant_or_prompt():
  metrics = MetricsRegistry()
  metrics.observe_http("POST", "/v2/ai/analyze", 200, 0.125)
  metrics.observe_rag_result("fallback", "vllm_timeout")
  metrics.observe_rag_retrieval("shadow", hit_count=2, duration_seconds=0.075)
  metrics.observe_rag_analysis("fallback", duration_seconds=0.125)
  metrics.observe_rag_validation("citations", "rejected")
  metrics.observe_generation("unavailable", duration_seconds=0.05, input_tokens=0)
  metrics.observe_information_delta("no_new_information")
  metrics.observe_memory("reconcile", "success", duration_seconds=0.02)
  metrics.set_job_depth("queued", 3)

  rendered = metrics.render()

  assert 'eisenhower_http_requests_total{method="POST",route="/v2/ai/analyze",status="200"} 1' in rendered
  assert 'eisenhower_rag_results_total{mode="fallback",reason="vllm_timeout"} 1' in rendered
  assert 'eisenhower_rag_retrieval_total{stage="shadow",outcome="hit"} 1' in rendered
  assert 'eisenhower_rag_retrieval_duration_seconds_sum{stage="shadow",outcome="hit"} 0.075000' in rendered
  assert 'eisenhower_rag_retrieval_duration_seconds_bucket{stage="shadow",outcome="hit",le="0.100"} 1' in rendered
  assert 'eisenhower_rag_retrieved_chunks_sum{stage="shadow"} 2' in rendered
  assert 'eisenhower_rag_analysis_duration_seconds_sum{mode="fallback"} 0.125000' in rendered
  assert 'eisenhower_rag_validation_total{kind="citations",outcome="rejected"} 1' in rendered
  assert 'eisenhower_rag_generation_total{outcome="unavailable"} 1' in rendered
  assert 'eisenhower_rag_input_tokens_sum{outcome="unavailable"} 0' in rendered
  assert 'eisenhower_information_delta_total{status="no_new_information"} 1' in rendered
  assert 'eisenhower_memory_operations_total{operation="reconcile",outcome="success"} 1' in rendered
  assert 'eisenhower_job_queue_depth{status="queued"} 3' in rendered
  assert "tenant" not in rendered
  assert "prompt" not in rendered


def test_prometheus_labels_are_bounded_instead_of_accepting_private_or_cardinal_values():
  metrics = MetricsRegistry()
  metrics.observe_rag_result("private-user-id", "private-document-title")
  metrics.observe_rag_retrieval("private-project-id", hit_count=None, duration_seconds=1)
  metrics.observe_rag_validation("private-chunk", "private-value")
  metrics.observe_memory("private-memory-id", "private-content", duration_seconds=1)
  metrics.observe_information_delta("private-known-statement")

  rendered = metrics.render()

  for private_value in (
    "private-user-id",
    "private-document-title",
    "private-project-id",
    "private-chunk",
    "private-value",
    "private-memory-id",
    "private-content",
    "private-known-statement",
  ):
    assert private_value not in rendered
  assert 'mode="other",reason="other"' in rendered
  assert 'stage="other",outcome="error"' in rendered
  assert 'kind="other",outcome="other"' in rendered
  assert 'operation="other",outcome="other"' in rendered
  assert 'status="other"' in rendered
