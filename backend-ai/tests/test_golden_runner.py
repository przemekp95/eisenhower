import pytest

from app.rag.golden import GoldenCase
from app.job_worker import PermanentJobError
from app.rag.golden_runner import (
  GoldenEvaluationRunner,
  RepositoryEvaluationHandler,
  RetrievalGoldenRunner,
  RetrievalStrategyComparisonRunner,
)
from app.rag.models import AnalyzeResult, Citation, RetrievalHit, RetrievalSummary


class Retriever:
  last_query = None

  def retrieve(self, query):
    self.last_query = query
    if "unknown" in query.text:
      return []
    return [RetrievalHit(
      chunk_id="chunk-1", document_id="doc-1", text="context", score=0.9,
      source_uri="eisenhower://doc-1", title="Doc", tenant_id=query.scope.tenant_id,
      project_id="p1", embedding_version="minilm-v1", content_version="v1",
    )]


class Service:
  retriever = Retriever()

  def analyze(self, task, _scope, *, language="en"):
    del language
    if "unknown" in task:
      return AnalyzeResult(mode="no_answer", explanation="No grounded answer.")
    return AnalyzeResult(
      mode="rag", quadrant=2, quadrant_name="Schedule", confidence=0.8,
      explanation="Grounded", retrieval=RetrievalSummary(hit_count=1),
      citations=[Citation(
        chunk_id="chunk-1", document_id="doc-1", source_uri="eisenhower://doc-1",
        title="Doc", excerpt="context", score=0.9, content_version="v1",
      )],
    )


def test_golden_runner_measures_retrieval_citations_no_answer_and_latency():
  cases = [
    GoldenCase(
      dataset_version="v1", case_id="answer", tenant_id="tenant-a", user_id="u1",
      project_ids=["p1"], query_project_id="p1", task="roadmap", expected_quadrant=2,
      answerability="answerable", relevant_document_ids=["doc-1"],
      expected_content_versions={"doc-1": "v1"}, split="holdout",
      allowed_citation_ids=["chunk-1"], tags=["test"],
    ),
    GoldenCase(
      dataset_version="v1", case_id="no-answer", tenant_id="tenant-a", user_id="u1",
      project_ids=["p1"], task="unknown", expected_quadrant=None,
      answerability="no_answer", tags=["test"],
    ),
  ]

  report = GoldenEvaluationRunner(Service(), clock=lambda: 1.0).run(cases, k=3)

  assert report["dataset_version"] == "v1"
  assert report["metrics"]["recall_at_k"] == 1.0
  assert report["metrics"]["citation_correctness"] == 1.0
  assert report["metrics"]["no_answer_accuracy"] == 1.0
  assert report["metrics"]["accuracy"] == 1.0
  assert report["metrics"]["no_answer"]["f1"] == 1.0
  assert report["metrics"]["freshness_rate"] == 1.0
  assert report["metrics"]["duplicate_hit_rate"] == 0.0
  assert report["metrics"]["by_split"]["holdout"]["cases"] == 1
  assert report["cases"][0]["retrieved_content_versions"] == ["v1"]
  assert Service.retriever.last_query.project_id is None


def test_golden_runner_passes_an_allowlisted_project_filter():
  service = Service()
  case = GoldenCase(
    dataset_version="v1", case_id="project-filter", tenant_id="tenant-a", user_id="u1",
    project_ids=["p1", "p2"], query_project_id="p2", task="roadmap",
    answerability="answerable", tags=["project-isolation"],
  )

  report = GoldenEvaluationRunner(service, clock=lambda: 1.0).run([case])

  assert service.retriever.last_query.project_id == "p2"
  assert report["cases"][0]["split"] == "dev"


def test_retrieval_runner_does_not_invoke_generation_and_scores_no_hit_separately():
  cases = [
    GoldenCase(
      dataset_version="v1", case_id="answer", tenant_id="tenant-a", user_id="u1",
      project_ids=["p1"], query_project_id="p1", task="roadmap",
      answerability="answerable", relevant_document_ids=["doc-1"], tags=["test"],
    ),
    GoldenCase(
      dataset_version="v1", case_id="no-answer", tenant_id="tenant-a", user_id="u1",
      project_ids=["p1"], task="unknown", answerability="no_answer", tags=["test"],
    ),
  ]

  report = RetrievalGoldenRunner(Retriever(), clock=lambda: 1.0).run(cases)

  assert report["mode"] == "retrieval_only"
  assert report["metrics"]["recall_at_k"] == 1.0
  assert report["metrics"]["mrr"] == 1.0
  assert report["metrics"]["no_answer_accuracy"] == 1.0
  assert report["cases"][1]["result_mode"] == "no_answer"


def test_golden_case_rejects_query_project_outside_access_scope():
  try:
    GoldenCase(
      dataset_version="v1", case_id="bad-project", tenant_id="tenant-a", user_id="u1",
      project_ids=["p1"], query_project_id="p2", task="roadmap",
      answerability="answerable", tags=["project-isolation"],
    )
  except ValueError as error:
    assert "query_project_id must belong to project_ids" in str(error)
  else:
    raise AssertionError("out-of-scope query projects must be rejected")


def test_repository_evaluation_handler_allowlists_dataset_and_writes_report_atomically(tmp_path):
  dataset = tmp_path / "golden.jsonl"
  dataset.write_text(GoldenCase(
    dataset_version="v1", case_id="answer", tenant_id="tenant-a", user_id="u1",
    project_ids=["p1"], task="roadmap", expected_quadrant=2,
    answerability="answerable", relevant_document_ids=["doc-1"],
    allowed_citation_ids=["chunk-1"], tags=["test"],
  ).model_dump_json() + "\n", encoding="utf-8")
  handler = RepositoryEvaluationHandler(
    service_factory=Service,
    datasets={"v1": dataset},
    output_dir=tmp_path / "results",
  )

  handler({"dataset_version": "v1"})

  assert (tmp_path / "results" / "v1.json").is_file()
  try:
    handler({"dataset_version": "not-allowlisted"})
  except PermanentJobError:
    pass
  else:
    raise AssertionError("unknown datasets must be rejected")


class ComparisonRetriever:
  def __init__(self, document_id):
    self.document_id = document_id
    self.queries = []

  def retrieve(self, query):
    self.queries.append(query.text)
    return [RetrievalHit(
      chunk_id=f"chunk-{self.document_id}", document_id=self.document_id,
      text="context", score=0.9, source_uri=f"note://{self.document_id}",
      title="Doc", tenant_id=query.scope.tenant_id, project_id=query.project_id,
      embedding_version="minilm-v1", content_version="v1",
    )]


def _comparison_case(case_id, language, split):
  return GoldenCase(
    dataset_version="comparison-v1", case_id=case_id, tenant_id="tenant-a",
    user_id="user-1", project_ids=["p1"], query_project_id="p1",
    language=language, split=split, task=f"query-{case_id}",
    answerability="answerable", relevant_document_ids=["doc-hybrid"], tags=["comparison"],
  )


def test_strategy_comparison_reports_dense_hybrid_optional_reranked_pl_en_and_latency():
  dense = ComparisonRetriever("doc-dense")
  hybrid = ComparisonRetriever("doc-hybrid")
  reranked = ComparisonRetriever("doc-hybrid")
  cases = [
    _comparison_case("dev-pl", "pl", "dev"),
    _comparison_case("train-en", "en", "train"),
    _comparison_case("holdout-pl", "pl", "holdout"),
    _comparison_case("holdout-en", "en", "holdout"),
  ]
  runner = RetrievalStrategyComparisonRunner({
    "dense": dense,
    "hybrid": hybrid,
    "reranked": reranked,
  })

  report = runner.run(cases, k=5)

  assert report["schema_version"] == "retrieval-strategy-comparison-v1"
  assert report["evaluated_split"] == "non_holdout"
  assert report["case_ids"] == ["dev-pl", "train-en"]
  assert list(report["strategies"]) == ["dense", "hybrid", "reranked"]
  assert report["strategies"]["dense"]["metrics"]["recall_at_k"] == 0.0
  assert report["strategies"]["hybrid"]["metrics"]["recall_at_k"] == 1.0
  for strategy in report["strategies"].values():
    assert set(strategy["metrics"]["by_language"]) == {"pl", "en"}
    assert set(strategy["metrics"]["latency_ms"]) == {"p50", "p95", "max"}
  assert "query-holdout-pl" not in hybrid.queries
  assert "query-holdout-en" not in hybrid.queries


def test_strategy_comparison_evaluates_holdout_only_when_explicitly_selected():
  dense = ComparisonRetriever("doc-dense")
  hybrid = ComparisonRetriever("doc-hybrid")
  cases = [
    _comparison_case("dev-pl", "pl", "dev"),
    _comparison_case("train-en", "en", "train"),
    _comparison_case("holdout-pl", "pl", "holdout"),
    _comparison_case("holdout-en", "en", "holdout"),
  ]

  report = RetrievalStrategyComparisonRunner({
    "dense": dense,
    "hybrid": hybrid,
  }).run(cases, split="holdout")

  assert report["evaluated_split"] == "holdout"
  assert report["case_ids"] == ["holdout-pl", "holdout-en"]
  assert hybrid.queries == ["query-holdout-pl", "query-holdout-en"]


def test_strategy_comparison_requires_dense_hybrid_and_both_language_slices():
  only_polish = [_comparison_case("dev-pl", "pl", "dev")]

  with pytest.raises(ValueError, match="dense and hybrid"):
    RetrievalStrategyComparisonRunner({"dense": ComparisonRetriever("doc-dense")})
  with pytest.raises(ValueError, match="Polish and English"):
    RetrievalStrategyComparisonRunner({
      "dense": ComparisonRetriever("doc-dense"),
      "hybrid": ComparisonRetriever("doc-hybrid"),
    }).run(only_polish)
