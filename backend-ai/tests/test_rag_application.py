import pytest

from app.generation.models import ClassificationOutput, GenerationResult
from app.rag.application import RagAnalysisService
from app.rag.errors import GenerationProviderUnavailable, InvalidGenerationOutput
from app.rag.models import AccessScope, RetrievalHit


class StubRetriever:
  def __init__(self, hits):
    self.hits = hits
    self.queries = []

  def retrieve(self, query):
    self.queries.append(query)
    return self.hits


class StubGenerator:
  def __init__(self, result=None, error=None):
    self.result = result
    self.error = error
    self.requests = []

  def generate(self, request):
    self.requests.append(request)
    if self.error:
      raise self.error
    return self.result


class StubFallback:
  def classify_task(self, _task, **_kwargs):
    return {"quadrant": 1, "quadrant_name": "Delegate", "confidence": 0.61}


def generation_result(output):
  return GenerationResult(
    output=output,
    execution_id="a" * 64,
    prompt_id="eisenhower-classifier",
    prompt_version="1.0.0",
    language="en",
    model_id="org/model",
    model_revision="model-revision",
    schema_version="1.0.0",
    input_tokens=100,
    context_chunk_ids=["chunk-1"],
  )


def classified_output(*, quadrant, urgent, important, citations):
  return ClassificationOutput(
    status="classified",
    urgent=urgent,
    important=important,
    quadrant=quadrant,
    facts=[],
    evidence=[],
    citations=citations,
    explanation="Grounded classification.",
    confidence=0.82,
    no_answer_reason=None,
  )


def test_rag_analysis_returns_only_acl_scoped_citations():
  hits = [
    RetrievalHit(
      chunk_id="chunk-1",
      document_id="doc-1",
      text="The roadmap is important but has no immediate deadline.",
      score=0.88,
      source_uri="task://roadmap",
      title="Roadmap",
      tenant_id="tenant-a",
      project_id="project-1",
      embedding_version="minilm-v1",
      content_version="v1",
    )
  ]
  generator = StubGenerator(
    generation_result(
      classified_output(quadrant=2, urgent=False, important=True, citations=["chunk-1"])
    )
  )
  service = RagAnalysisService(StubRetriever(hits), generator, StubFallback())

  result = service.analyze(
    "Prepare strategic roadmap",
    AccessScope(tenant_id="tenant-a", user_id="user-1", project_ids=["project-1"]),
  )

  assert result.mode == "rag"
  assert result.quadrant == 2
  assert result.citations[0].chunk_id == "chunk-1"
  assert result.citations[0].source_uri == "task://roadmap"
  assert result.model_dump()["retrieval"]["hit_count"] == 1
  assert result.generation.execution_id == "a" * 64
  assert generator.requests[0].language == "en"


def test_rag_analysis_rejects_generator_citations_not_present_in_context():
  hit = RetrievalHit(
    chunk_id="allowed",
    document_id="doc-1",
    text="Known context",
    score=0.8,
    source_uri="knowledge://1",
    title="Known",
    tenant_id="tenant-a",
    embedding_version="minilm-v1",
    content_version="v1",
  )
  generator = StubGenerator(
    generation_result(
      classified_output(quadrant=0, urgent=True, important=True, citations=["invented"])
    )
  )
  service = RagAnalysisService(StubRetriever([hit]), generator, StubFallback())

  result = service.analyze("Task", AccessScope(tenant_id="tenant-a", user_id="user-1"))

  assert result.mode == "fallback"
  assert result.fallback_reason == "invalid_citations"
  assert result.citations == []


def test_rag_analysis_returns_no_answer_for_valid_insufficient_evidence():
  hit = RetrievalHit(
    chunk_id="chunk-1",
    document_id="doc-1",
    text="Context without urgency or importance evidence.",
    score=0.8,
    source_uri="knowledge://1",
    title="Known",
    tenant_id="tenant-a",
    embedding_version="minilm-v1",
    content_version="v1",
  )
  output = ClassificationOutput(
    status="insufficient_evidence",
    urgent=None,
    important=None,
    quadrant=None,
    facts=[],
    evidence=[],
    citations=[],
    explanation="Missing evidence for both axes.",
    confidence=None,
    no_answer_reason="missing_urgency_and_importance",
  )
  service = RagAnalysisService(
    StubRetriever([hit]),
    StubGenerator(generation_result(output)),
    StubFallback(),
  )

  result = service.analyze(
    "Ambiguous task",
    AccessScope(tenant_id="tenant-a", user_id="user-1"),
    language="pl",
  )

  assert result.mode == "no_answer"
  assert result.quadrant is None
  assert result.fallback_reason == "missing_urgency_and_importance"


def test_rag_analysis_falls_back_when_retrieval_has_no_grounding():
  service = RagAnalysisService(StubRetriever([]), StubGenerator(), StubFallback())

  result = service.analyze("Task", AccessScope(tenant_id="tenant-a", user_id="user-1"))

  assert result.mode == "fallback"
  assert result.quadrant == 1
  assert result.fallback_reason == "no_retrieval_hits"


def test_rag_analysis_falls_back_when_generation_provider_is_unavailable():
  hit = RetrievalHit(
    chunk_id="chunk-1",
    document_id="doc-1",
    text="Known context",
    score=0.8,
    source_uri="knowledge://1",
    title="Known",
    tenant_id="tenant-a",
    embedding_version="minilm-v1",
    content_version="v1",
  )
  service = RagAnalysisService(
    StubRetriever([hit]),
    StubGenerator(error=GenerationProviderUnavailable("vLLM timeout")),
    StubFallback(),
  )

  result = service.analyze("Task", AccessScope(tenant_id="tenant-a", user_id="user-1"))

  assert result.mode == "fallback"
  assert result.fallback_reason == "generation_unavailable"


def test_retrieval_only_analysis_collects_summary_without_calling_generation():
  hit = RetrievalHit(
    chunk_id="chunk-1",
    document_id="doc-1",
    text="Known context",
    score=0.8,
    source_uri="knowledge://1",
    title="Known",
    tenant_id="tenant-a",
    embedding_version="minilm-v1",
    content_version="v1",
  )
  service = RagAnalysisService(StubRetriever([hit]), None, StubFallback())

  result = service.analyze("Task", AccessScope(tenant_id="tenant-a", user_id="user-1"))

  assert service.generation_enabled is False
  assert result.mode == "fallback"
  assert result.fallback_reason == "generation_disabled"
  assert result.retrieval.hit_count == 1


def test_rag_analysis_falls_back_when_generation_output_is_invalid():
  hit = RetrievalHit(
    chunk_id="chunk-1",
    document_id="doc-1",
    text="Known context",
    score=0.8,
    source_uri="knowledge://1",
    title="Known",
    tenant_id="tenant-a",
    embedding_version="minilm-v1",
    content_version="v1",
  )
  service = RagAnalysisService(
    StubRetriever([hit]),
    StubGenerator(error=InvalidGenerationOutput("malformed schema")),
    StubFallback(),
  )

  result = service.analyze("Task", AccessScope(tenant_id="tenant-a", user_id="user-1"))

  assert result.mode == "fallback"
  assert result.fallback_reason == "invalid_generation_output"


def test_rag_analysis_does_not_hide_unexpected_programming_errors():
  hit = RetrievalHit(
    chunk_id="chunk-1",
    document_id="doc-1",
    text="Known context",
    score=0.8,
    source_uri="knowledge://1",
    title="Known",
    tenant_id="tenant-a",
    embedding_version="minilm-v1",
    content_version="v1",
  )
  service = RagAnalysisService(
    StubRetriever([hit]),
    StubGenerator(error=ValueError("programming error")),
    StubFallback(),
  )

  with pytest.raises(ValueError, match="programming error"):
    service.analyze("Task", AccessScope(tenant_id="tenant-a", user_id="user-1"))


def test_knowledge_search_returns_retrieval_citations_without_generation():
  hit = RetrievalHit(
    chunk_id="chunk-1",
    document_id="doc-1",
    text="Known project context",
    score=0.8,
    source_uri="knowledge://1",
    title="Known",
    tenant_id="tenant-a",
    project_id="project-1",
    embedding_version="minilm-v1",
    content_version="v1",
  )
  retriever = StubRetriever([hit])
  service = RagAnalysisService(retriever, StubGenerator(), StubFallback())

  result = service.search(
    "project context",
    AccessScope(tenant_id="tenant-a", user_id="user-1", project_ids=["project-1"]),
    limit=5,
  )

  assert result["citations"][0].chunk_id == "chunk-1"
  assert result["answer"] is None
  assert retriever.queries[0].limit == 5
