from app.rag.evaluation import EvaluationCaseResult, evaluate_results


def test_evaluation_reports_recall_mrr_grounding_citations_no_answer_and_latency():
  results = [
    EvaluationCaseResult(
      case_id="1",
      relevant_document_ids=["doc-a"],
      retrieved_document_ids=["doc-a", "doc-b"],
      allowed_citation_ids=["chunk-a"],
      actual_citation_ids=["chunk-a"],
      expected_no_answer=False,
      actual_no_answer=False,
      grounded=True,
      latency_ms=120,
      language="en",
      expected_quadrant=2,
      actual_quadrant=2,
      raw_confidence=0.8,
      schema_valid=True,
      injection_attempt=False,
      injection_success=False,
      result_mode="rag",
      prompt_tokens=100,
      output_tokens=40,
    ),
    EvaluationCaseResult(
      case_id="2",
      relevant_document_ids=["doc-z"],
      retrieved_document_ids=["doc-b", "doc-z"],
      allowed_citation_ids=["chunk-z"],
      actual_citation_ids=["invented"],
      expected_no_answer=True,
      actual_no_answer=False,
      grounded=False,
      latency_ms=300,
      language="pl",
      expected_quadrant=1,
      actual_quadrant=2,
      raw_confidence=0.7,
      schema_valid=True,
      injection_attempt=True,
      injection_success=True,
      result_mode="rag",
      prompt_tokens=200,
      output_tokens=50,
    ),
  ]

  metrics = evaluate_results(results, k=2)

  assert metrics["recall_at_k"] == 1.0
  assert metrics["mrr"] == 0.75
  assert metrics["groundedness"] == 0.5
  assert metrics["citation_correctness"] == 0.5
  assert metrics["citation_recall"] == 0.5
  assert metrics["no_answer_accuracy"] == 0.5
  assert metrics["accuracy"] == 0.5
  assert metrics["macro_f1"] == 0.1667
  assert metrics["per_quadrant"]["2"]["precision"] == 0.5
  assert metrics["schema_valid_rate"] == 1.0
  assert metrics["injection_attack_success_rate"] == 1.0
  assert metrics["fallback_rate"] == 0.0
  assert metrics["calibration"]["brier_score"] == 0.265
  assert metrics["tokens"]["prompt_mean"] == 150.0
  assert metrics["latency_ms"]["p95"] == 300


def test_evaluation_reports_duplicate_freshness_isolation_no_hit_and_split_metrics():
  results = [
    EvaluationCaseResult(
      case_id="dev-isolation",
      relevant_document_ids=["doc-current"],
      retrieved_document_ids=["doc-current", "doc-current", "doc-forbidden"],
      retrieved_chunk_ids=["chunk-current", "chunk-current", "chunk-secret"],
      retrieved_content_versions=["v2", "v1", "v9"],
      forbidden_document_ids=["doc-forbidden"],
      stale_document_ids=[],
      expected_content_versions={"doc-current": "v2"},
      duplicate_hit_ids=["chunk-current"],
      allowed_citation_ids=[],
      actual_citation_ids=[],
      expected_no_answer=False,
      actual_no_answer=False,
      grounded=True,
      latency_ms=10,
      split="dev",
    ),
    EvaluationCaseResult(
      case_id="holdout-no-hit",
      relevant_document_ids=["doc-missing"],
      retrieved_document_ids=[],
      stale_document_ids=["doc-old"],
      allowed_citation_ids=[],
      actual_citation_ids=[],
      expected_no_answer=True,
      actual_no_answer=True,
      grounded=False,
      latency_ms=5,
      split="holdout",
    ),
  ]

  metrics = evaluate_results(results, k=3)

  assert metrics["duplicate_hit_rate"] == 0.3333
  assert metrics["document_duplicate_rate"] == 0.3333
  assert metrics["freshness_rate"] == 0.6667
  assert metrics["stale_hit_rate"] == 0.3333
  assert metrics["stale_case_rate"] == 0.5
  assert metrics["forbidden_hit_rate"] == 0.3333
  assert metrics["isolation_hit_rate"] == 0.3333
  assert metrics["forbidden_case_rate"] == 0.5
  assert metrics["isolation_violation_rate"] == 0.5
  assert metrics["no_hit_rate"] == 0.5
  assert metrics["by_split"]["dev"]["forbidden_hit_rate"] == 0.3333
  assert metrics["by_split"]["holdout"]["no_hit_rate"] == 1.0


def test_evaluation_derives_duplicate_hits_for_backward_compatible_results():
  result = EvaluationCaseResult(
    case_id="legacy",
    relevant_document_ids=[],
    retrieved_document_ids=["doc-a", "doc-a"],
    allowed_citation_ids=[],
    actual_citation_ids=[],
    expected_no_answer=False,
    actual_no_answer=False,
    grounded=False,
    latency_ms=0,
  )

  metrics = evaluate_results([result], k=2)

  assert metrics["duplicate_hit_rate"] == 0.5
  assert metrics["document_duplicate_rate"] == 0.5
  assert metrics["freshness_rate"] == 1.0
