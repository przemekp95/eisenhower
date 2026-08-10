from app.rag.golden import GoldenCase
from app.job_worker import PermanentJobError
from app.rag.golden_runner import GoldenEvaluationRunner, RepositoryEvaluationHandler
from app.rag.models import AnalyzeResult, Citation, RetrievalHit, RetrievalSummary


class Retriever:
  def retrieve(self, query):
    if "unknown" in query.text:
      return []
    return [RetrievalHit(
      chunk_id="chunk-1", document_id="doc-1", text="context", score=0.9,
      source_uri="eisenhower://doc-1", title="Doc", tenant_id=query.scope.tenant_id,
      project_id="p1", embedding_version="minilm-v1", content_version="v1",
    )]


class Service:
  retriever = Retriever()

  def analyze(self, task, _scope):
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
      project_ids=["p1"], task="roadmap", expected_quadrant=2,
      answerability="answerable", relevant_document_ids=["doc-1"],
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
