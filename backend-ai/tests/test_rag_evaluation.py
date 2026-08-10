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
    ),
  ]

  metrics = evaluate_results(results, k=2)

  assert metrics["recall_at_k"] == 1.0
  assert metrics["mrr"] == 0.75
  assert metrics["groundedness"] == 0.5
  assert metrics["citation_correctness"] == 0.5
  assert metrics["no_answer_accuracy"] == 0.5
  assert metrics["latency_ms"]["p95"] == 300
