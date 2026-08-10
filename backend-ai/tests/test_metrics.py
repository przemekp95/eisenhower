from app.metrics import MetricsRegistry


def test_prometheus_metrics_are_aggregate_and_do_not_leak_tenant_or_prompt():
  metrics = MetricsRegistry()
  metrics.observe_http("POST", "/v2/ai/analyze", 200, 0.125)
  metrics.observe_rag_result("fallback", "vllm_timeout")
  metrics.observe_rag_retrieval("shadow", hit_count=2)
  metrics.set_job_depth("queued", 3)

  rendered = metrics.render()

  assert 'eisenhower_http_requests_total{method="POST",route="/v2/ai/analyze",status="200"} 1' in rendered
  assert 'eisenhower_rag_results_total{mode="fallback",reason="vllm_timeout"} 1' in rendered
  assert 'eisenhower_rag_retrieval_total{stage="shadow",outcome="hit"} 1' in rendered
  assert 'eisenhower_job_queue_depth{status="queued"} 3' in rendered
  assert "tenant" not in rendered
  assert "prompt" not in rendered
